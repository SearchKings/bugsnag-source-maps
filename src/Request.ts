import https from 'https'
import http from 'http'
import concat from 'concat-stream'
import url from 'url'
import FormData from 'form-data'
import { NetworkError, NetworkErrorCode } from './NetworkError'
import File from './File'

export const enum PayloadType { Browser, ReactNative, Node }
type Payload = BrowserPayload | ReactNativePayload | NodePayload

type BrowserPayload = JsPayload
type NodePayload = JsPayload

interface JsPayload {
  type: PayloadType.Node | PayloadType.Browser
  apiKey: string
  appVersion?: string
  codeBundleId?: string
  minifiedUrl: string
  sourceMap: File
  minifiedFile?: File
  overwrite?: boolean
}

interface ReactNativePayload {
  type: PayloadType.ReactNative
  apiKey: string
  platform: 'ios' | 'android'
  appVersion?: string
  codeBundleId?: string,
  appBundleVersion?: string
  appVersionCode?: string
  overwrite: boolean
  dev: boolean
  sourceMap: File
  bundle: File
}

interface RequestOptions {
  idleTimeout?: number
}

const MAX_ATTEMPTS = 5
const RETRY_INTERVAL_MS = parseInt(process.env.BUGSNAG_RETRY_INTERVAL_MS as string) || 1000
const DEFAULT_TIMEOUT_MS = parseInt(process.env.BUGSNAG_TIMEOUT_MS as string) || 60000

export default async function request (
  endpoint: string,
  payload: Payload,
  requestOpts: http.RequestOptions,
  options: RequestOptions = {}
): Promise<void> {
  let attempts = 0
  const go = async (): Promise<void> => {
    try {
      attempts++
      await send(endpoint, payload, requestOpts, options)
    } catch (err) {
      if (err instanceof NetworkError) {
        if (err && err.isRetryable !== false && attempts < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS))
          return await go()
        }
      }
      throw err
    }
  }
  await go()
}

function createFormData (payload: Payload): FormData {
  const formData = new FormData()
  formData.append('apiKey', payload.apiKey)

  switch (payload.type) {
    case PayloadType.Browser:
    case PayloadType.Node:
      return appendJsFormData(formData, payload)

    case PayloadType.ReactNative:
      return appendReactNativeFormData(formData, payload)
  }
}

function appendJsFormData(formData: FormData, payload: BrowserPayload | NodePayload): FormData {
  if (payload.appVersion) formData.append('appVersion', payload.appVersion)
  if (payload.codeBundleId) formData.append('codeBundleId', payload.codeBundleId)
  formData.append('minifiedUrl', payload.minifiedUrl)
  formData.append('sourceMap', payload.sourceMap.data, { filepath: payload.sourceMap.filepath})
  if (payload.minifiedFile) formData.append('minifiedFile', payload.minifiedFile.data, { filepath: payload.minifiedFile.filepath})
  if (payload.overwrite) formData.append('overwrite', payload.overwrite.toString())

  return formData
}

function appendReactNativeFormData(formData: FormData, payload: ReactNativePayload): FormData {
  formData.append('platform', payload.platform)
  formData.append('overwrite', payload.overwrite.toString())
  formData.append('dev', payload.dev.toString())
  formData.append('sourceMap', payload.sourceMap.data, { filepath: payload.sourceMap.filepath })
  formData.append('bundle', payload.bundle.data, { filepath: payload.bundle.filepath })

  if (payload.appVersion) {
    formData.append('appVersion', payload.appVersion)
  }

  if (payload.codeBundleId) {
    formData.append('codeBundleId', payload.codeBundleId)
  }

  if (payload.appBundleVersion) {
    formData.append('appBundleVersion', payload.appBundleVersion)
  }

  if (payload.appVersionCode) {
    formData.append('appVersionCode', payload.appVersionCode)
  }

  return formData
}

export async function send (
  endpoint: string,
  payload: Payload,
  requestOpts: http.RequestOptions,
  options: RequestOptions = {}
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const formData = createFormData(payload)

    const parsedUrl = url.parse(endpoint)
    const req = (parsedUrl.protocol === 'https:' ? https : http).request({
      method: 'POST',
      hostname: parsedUrl.hostname,
      path: parsedUrl.path || '/',
      headers: formData.getHeaders(),
      port: parsedUrl.port || undefined,
      agent: requestOpts && requestOpts.agent
    }, res => {
      res.pipe(concat((bodyBuffer: Buffer) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) return resolve()
        const err = new NetworkError(`HTTP status ${res.statusCode} received from upload API`)
        err.responseText = bodyBuffer.toString()
        if (!isRetryable(res.statusCode)) {
          err.isRetryable = false
        }
        if (res.statusCode && (res.statusCode >= 400 && res.statusCode < 500)) {
          switch (res.statusCode) {
            case 401:
              err.code = NetworkErrorCode.INVALID_API_KEY
              break
            case 409:
              err.code = NetworkErrorCode.DUPLICATE
              break
            case 422:
              err.code = NetworkErrorCode.EMPTY_FILE
              break
            default:
              err.code = NetworkErrorCode.MISC_BAD_REQUEST
          }
        } else {
          err.code = NetworkErrorCode.SERVER_ERROR
        }
        return reject(err)
      }))
    })

    formData.pipe(req)

    addErrorHandler(req, reject)
    addTimeout(req, reject, options)
  })
}

export function isRetryable (status?: number): boolean {
  return (
    !status || (
      status < 400 ||
      status > 499 ||
      [
        408, // timeout
        429 // too many requests
      ].indexOf(status) !== -1)
    )
}

export function fetch(endpoint: string, options: RequestOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const parsedUrl = url.parse(endpoint)

    const req = (parsedUrl.protocol === 'https:' ? https : http).get(endpoint, res => {
      res.pipe(concat((bodyBuffer: Buffer) => {
        if (res.statusCode === 200) {
          return resolve(bodyBuffer.toString())
        }

        const err = new NetworkError(`HTTP status ${res.statusCode} received from bundle server`)
        err.responseText = bodyBuffer.toString()

        if (!isRetryable(res.statusCode)) {
          err.isRetryable = false
        }

        if (res.statusCode && (res.statusCode >= 400 && res.statusCode < 500)) {
          err.code = NetworkErrorCode.MISC_BAD_REQUEST
        } else {
          err.code = NetworkErrorCode.SERVER_ERROR
        }

        return reject(err)
      }))
    })

    addErrorHandler(req, reject)
    addTimeout(req, reject, options)
  })
}

function addErrorHandler(req: http.ClientRequest, reject: (reason: NetworkError) => void): void {
  req.on('error', e => {
    const err = new NetworkError('Unknown connection error')
    err.cause = e

    const failureReason = (e as NodeJS.ErrnoException).code

    if (failureReason === 'ECONNREFUSED') {
      err.code = NetworkErrorCode.CONNECTION_REFUSED
    } else {
      err.code = NetworkErrorCode.UNKNOWN
    }

    reject(err)
  })
}

const minutesToMilliseconds = (minutes: number): number => minutes * 60 * 1000

function addTimeout(
  req: http.ClientRequest,
  reject: (reason: NetworkError) => void,
  options: RequestOptions
): void {
  const timeout = options.idleTimeout
    ? minutesToMilliseconds(options.idleTimeout)
    : DEFAULT_TIMEOUT_MS

  req.setTimeout(timeout, () => {
    const err = new NetworkError('Connection timed out')
    err.code = NetworkErrorCode.TIMEOUT
    reject(err)
    req.abort()
  })
}
