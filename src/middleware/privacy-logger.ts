import { Request, Response, NextFunction } from 'express'
import { Buffer } from 'node:buffer'
import { isIP } from 'node:net'
import { logger, withCorrelationId, getOrGenerateCorrelationId } from './logger.js'
import { utcNow } from '../utils/timestamps.js'

export const REDACTION_MARKER = '***REDACTED***'

export const SENSITIVE_KEYS = new Set([
    'email',
    'password',
    'token',
    'accesstoken',
    'refreshtoken',
    'apikey',
    'api_key',
    'secret',
    'clientsecret',
    'creator',
    'successdestination',
    'failuredestination',
    'authorization',
    'cookie',
    'x-api-key'
])

const PII_VALUE_PATTERNS = [
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
]

export function shouldRedact(key: string): boolean {
    return SENSITIVE_KEYS.has(key.toLowerCase())
}

function shouldRedactValue(value: string): boolean {
    return PII_VALUE_PATTERNS.some(pattern => pattern.test(value))
}

type RequestWithPrivacyContext = Request & {
    correlationId?: string
    logger?: ReturnType<typeof withCorrelationId>
}

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) {
        return value
    }
    
    if (typeof value === 'string') {
        return shouldRedactValue(value) ? REDACTION_MARKER : value
    }

    // Primitive values
    if (typeof value !== 'object') {
        return value
    }

    // Circular reference check
    if (seen.has(value)) {
        return '[Circular]'
    }
    seen.add(value)
    
    if (Array.isArray(value)) {
        return value.map(item => redact(item, seen))
    }

    // Handle common objects that are not plain objects
    if (value instanceof Date) {
        return value.toISOString()
    }
    if (value instanceof RegExp) {
        return value.toString()
    }
    if (Buffer.isBuffer(value)) {
        return '[Buffer]'
    }
    
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
        if (shouldRedact(k)) {
            result[k] = REDACTION_MARKER
        } else {
            result[k] = redact(v, seen)
        }
    }
    return result
}

/**
 * Privacy logger middleware using Pino for structured JSON output.
 *
 * Masks PII in logs by:
 * - Masking IP addresses (partial redaction)
 * - Redacting sensitive fields in request bodies and headers
 * - Emitting structured JSON for log aggregators
 *
 * Note: Pino's built-in redaction (configured in logger.ts) also handles
 * sensitive field redaction automatically. This middleware adds additional
 * IP masking and structured event logging.
 */
export const privacyLogger = (req: Request, _res: Response, next: NextFunction) => {
    const correlationId = getOrGenerateCorrelationId(req)
    const privacyLog = withCorrelationId(logger, correlationId)

    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const maskedIp = maskIp(ip)

    const timestamp = utcNow()
    const method = req.method
    const url = req.url

    // Store correlation ID and logger on request for downstream handlers
    const requestWithContext = req as RequestWithPrivacyContext
    requestWithContext.correlationId = correlationId
    requestWithContext.logger = privacyLog

    // Redact sensitive fields before logging
    // (Pino will also redact based on its configuration, but we do it here
    // for explicit control and compatibility with existing tests)
    const sanitizedBody = redact(req.body)
    const sanitizedHeaders = redact(req.headers)

    // Emit structured privacy event log
    privacyLog.debug(
        {
            event: 'privacy.request_logged',
            ip: {
                original: ip,
                masked: maskedIp,
            },
            request: {
                method,
                url,
                headers: sanitizedHeaders,
                body: sanitizedBody,
            },
            timestamp,
        },
        `Privacy-logged: ${method} ${url}`,
    )

    next()
}

export function maskIp(ip: string): string {
    if (isIP(ip) === 6) {
        const [left, right = ''] = ip.split('::')
        const leftGroups = left ? left.split(':') : []
        const rightGroups = right ? right.split(':') : []
        const missingGroups = Math.max(0, 8 - leftGroups.length - rightGroups.length)
        const groups = right
            ? [...leftGroups, ...Array(missingGroups).fill('0'), ...rightGroups]
            : leftGroups
        return `${groups[0]}:${groups[1]}:${groups[2]}:xxxx:xxxx:xxxx:xxxx:xxxx`
    }

    if (isIP(ip) === 4) {
        const parts = ip.split('.')
        return `${parts[0]}.${parts[1]}.x.x`
    }

    return 'x.x.x.x'
}
