import * as async from 'https://deno.land/std/async/mod.ts'
import * as what from 'https://deno.land/x/is_what/src/index.ts'
import arrify from 'https://esm.sh/arrify?dev'
import Db from './storage.ts'
import deepmerge from 'https://esm.sh/deepmerge?dev'
import hashIt from 'https://esm.sh/hash-it?dev'
import { getCookies } from 'https://deno.land/std/http/cookie.ts'
import { Status, STATUS_TEXT } from 'https://deno.land/std/http/http_status.ts'

export interface HttpInit extends Omit<RequestInit, 'headers' | 'signal'> {
	buildRequest: ((init: HttpInit) => Promise<void> | void)[]
	cookies?: boolean
	debug?: boolean
	delay?: number
	form?: object
	headers: Record<string, string>
	json?: unknown
	memoize?: number
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'HEAD' | 'DELETE' | 'OPTIONS'
	multipart?: object
	prefixUrl?: string
	randelay?: number
	retries: number
	retryMethods: Set<HttpInit['method']>
	retryStatusCodes: Set<number>
	searchParams: object
	timeout: number
}

export class HttpError extends DOMException {
	constructor(public input: string, public init: HttpInit, public response: Response) {
		super(response.statusText ?? STATUS_TEXT.get(response.status), 'HttpError')
		Object.defineProperty(this, 'code', { value: this.response.status })
	}
}

export class AbortError extends DOMException {
	constructor(public input: string, public init: HttpInit) {
		super('Aborted', 'AbortError')
	}
}

export class Http {
	static get defaults() {
		return {
			buildRequest: [],
			headers: {
				'user-agent': 'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1; Trident/4.0)',
			},
			method: 'GET',
			retries: 2,
			retryMethods: new Set<HttpInit['method']>(['GET', 'HEAD', 'DELETE', 'OPTIONS']),
			retryStatusCodes: new Set<number>([403, 408, 413, 429, 500, 502, 503, 504]),
			searchParams: {},
			timeout: 10000,
		} as HttpInit
	}

	static randelay(delay: number) {
		let [min, max] = [delay * Math.E * 0.1, delay]
		return Math.ceil(Math.floor(Math.random() * (max - min + 1)) + min)
	}

	static merge(x: Partial<HttpInit>, y: Partial<HttpInit>) {
		return deepmerge(x, y, {
			isMergeableObject: (value) => {
				return Array.isArray(value) || what.isPlainObject(value)
			},
		})
	}

	static toIterable<T extends FormData | Headers | URLSearchParams>(iterable: T, input: object) {
		for (let [key, value] of Object.entries(input)) {
			if (what.isNullOrUndefined(value)) {
				continue
			} else if (Array.isArray(value)) {
				value.forEach((v) => iterable.append(key, v))
			} else if (iterable instanceof URLSearchParams) {
				iterable.set(key, value)
			} else {
				iterable.append(key, value)
			}
		}
		return iterable
	}

	constructor(public options = {} as Partial<HttpInit>) {
		this.options = Http.merge(Http.defaults, options)
	}

	extend(options: Partial<HttpInit>) {
		return new Http(Http.merge(this.options, options))
	}

	private async fetch(input: string, init: HttpInit): Promise<Response> {
		try {
			let response: Response
			if (Number.isFinite(init.timeout) && init.timeout > 0) {
				let aborter = async.deferred<never>()
				let controller = new AbortController()
				let timer = setTimeout(() => {
					controller.abort()
					aborter.reject(new AbortError(input, init))
				}, init.timeout)
				response = await Promise.race([
					fetch(input, { ...init, signal: controller.signal }),
					aborter,
				]).finally(() => clearTimeout(timer))
			} else {
				response = await fetch(input, init)
			}
			if (!response.ok) {
				throw new HttpError(input, init, response)
			}
			return response
		} catch (error) {
			if (init.retries > 0 && init.retryMethods.has(init.method)) {
				if (
					error instanceof AbortError ||
					(error instanceof HttpError && init.retryStatusCodes.has(error.response.status))
				) {
					let delay = NaN
					if (error instanceof HttpError && error.response.headers.has('retry-after')) {
						let after = error.response.headers.get('retry-after')!
						let date = Date.parse(after)
						if (Number.isFinite(date)) {
							delay = Math.abs(date - Date.now())
						} else {
							delay = Number(after) * 1000
						}
					}
					if (!Number.isFinite(delay)) {
						delay = Http.randelay(1000)
					}
					await async.delay(delay)
					init.retries--
					return this.fetch(input, init)
				}
			}
			throw error
		}
	}

	async request(input: string, options = {} as Partial<HttpInit>) {
		let init = Http.merge(this.options, options)

		for (let hook of init.buildRequest) {
			await hook(init)
		}

		let headers = new Headers(init.headers)
		let url = new URL(init.prefixUrl ?? input)
		if (init.prefixUrl) {
			let prefixUrl = init.prefixUrl
			if (!url.pathname.endsWith('/') && !'#&?'.includes(input.charAt(0))) {
				prefixUrl += '/'
			}
			url = new URL(input.startsWith('/') ? input.slice(1) : input, prefixUrl)
		}
		Http.toIterable(url.searchParams, init.searchParams)

		if (init.json) {
			init.body = JSON.stringify(init.json)
			if (!headers.has('content-type')) {
				headers.set('content-type', 'application/json')
			}
		}

		if (init.form) {
			init.body = Http.toIterable(new URLSearchParams(), init.form)
		}

		if (init.multipart) {
			init.body = Http.toIterable(new FormData(), init.multipart)
		}

		let reqid = ''
		if (typeof init.memoize == 'number' && init.memoize > 0) {
			let reqs = [init.method, url.toString(), arrify(headers), arrify(init.body)]
			// console.log('reqs ->', reqs)
			reqid = hashIt(reqs).toString()
			let db = new Db(`memoize:${url.hostname}`)
			let memoized = await db.get(reqid)
			if (Array.isArray(memoized)) {
				let [body, headers, init] = memoized
				let response = new Response(body, init)
				Object.assign(response, init, { headers: new Headers(headers) })
				return response
			}
		}

		if (init.cookies == true) {
			let db = new Db(`cookies:${url.hostname}`)
			// await db.clear()
			for (let [name, value] of await db.entries()) {
				// console.log('name, value ->', name, value)
				headers.append('cookie', `${name}=${value}`)
			}
			if (headers.has('cookie')) {
				headers.set('cookie', headers.get('cookie')!.replaceAll(', ', '; '))
			}
			// console.warn('cookies ->', headers.get('cookie'))
		}

		if (init.delay) {
			await async.delay(init.delay)
		}
		if (init.randelay) {
			await async.delay(Http.randelay(init.randelay))
		}

		// console.log('url ->', url)
		// console.log('headers ->', [...headers])
		Object.assign(init, { headers })
		if (init.debug == true) {
			console.log(`[${init.method}]`, `${url.host}${url.pathname}`, init)
		}
		let response = await this.fetch(url.toString(), init)

		if (init.cookies == true) {
			let db = new Db(`cookies:${url.hostname}`)
			for (let [key, value] of response.headers.entries()) {
				if (key != 'set-cookie') continue
				let cookie = getCookies({ headers: new Headers({ cookie: value }) })
				let keys = ['domain', 'expires', 'httponly', 'maxage', 'path', 'samesite', 'secure']
				let name = Object.keys(cookie).find((k) => !keys.includes(k.toLowerCase()))
				if (!name) continue
				let expires = Date.parse(cookie.expires || cookie.Expires)
				if (Number.isFinite(expires) && expires > Date.now()) {
					await db.set(name, cookie[name], expires - Date.now())
				} else {
					await db.set(name, cookie[name])
				}
			}
		}

		if (typeof init.memoize == 'number' && init.memoize > 0) {
			let memoized = Object.assign(response.clone(), response)
			let body = await memoized.text()
			let db = new Db(`memoize:${url.hostname}`)
			await db.set(reqid, [body, [...memoized.headers], memoized], init.memoize)
		}

		// let memoized = new Response(response.body, response)
		// Object.assign(memoized, response)
		// console.log('memoized ->', JSON.stringify(memoized))

		return response

		// if (response.headers.get('content-type')?.startsWith('application/json')) {
		// 	return await response.json()
		// }
	}

	async arrayBuffer(input: string, options = {} as Partial<HttpInit>) {
		return (await this.request(input, options)).arrayBuffer()
	}
	async blob(input: string, options = {} as Partial<HttpInit>) {
		return (await this.request(input, options)).blob()
	}
	async formData(input: string, options = {} as Partial<HttpInit>) {
		return (
			await this.request(
				input,
				Http.merge({ headers: { accept: 'multipart/form-data' } }, options),
			)
		).formData()
	}
	async json<T = unknown>(input: string, options = {} as Partial<HttpInit>) {
		let response = await this.request(
			input,
			Http.merge({ headers: { accept: 'application/json' } }, options),
		)
		try {
			return JSON.parse((await response.text()) as any) as T
		} catch {
			return {} as never
		}
	}
	async text(input: string, options = {} as Partial<HttpInit>) {
		return (
			await this.request(input, Http.merge({ headers: { accept: 'text/*' } }, options))
		).text()
	}

	get(input: string, options = {} as Partial<HttpInit>) {
		options.method = 'GET'
		return this.request(input, options)
	}
	post(input: string, options = {} as Partial<HttpInit>) {
		options.method = 'POST'
		return this.request(input, options)
	}
	put(input: string, options = {} as Partial<HttpInit>) {
		options.method = 'PUT'
		return this.request(input, options)
	}
	patch(input: string, options = {} as Partial<HttpInit>) {
		options.method = 'PATCH'
		return this.request(input, options)
	}
	head(input: string, options = {} as Partial<HttpInit>) {
		options.method = 'HEAD'
		return this.request(input, options)
	}
	delete(input: string, options = {} as Partial<HttpInit>) {
		options.method = 'DELETE'
		return this.request(input, options)
	}
}

export default new Http()
