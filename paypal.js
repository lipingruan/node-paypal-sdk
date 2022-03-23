
const { EventEmitter } = require ( 'events' )

const crypto = require ( 'crypto' )

const IO = require ( './util/io' )

const secured = Symbol ( 'secured' )



module.exports = class Paypal extends EventEmitter {



    #store = {
        token: '',

        // token 过期时间
        tokenExpires: 0,

        // token 获取中
        tokenUpdating: false,
    }



    #config = {
        sandbox: true,
        clientId: '',
        clientSecret: '',

        // 店铺名称
        brandName: '',

        /**
         * 货币类型, USD:美元
         * @type {string}
         */
        currencyCode: 'USD',
    }



    constructor ( config ) {
        super ( )

        if ( config ) this.config = config
    }



    set config ( config ) {

        Object.assign ( this.#config, config )
    }



    get config ( ) {

        return this.#config
    }



    get urlPrefix ( ) {

        return this.#config.sandbox ?
            'https://api-m.sandbox.paypal.com' :
            'https://api-m.paypal.com'
    }



    urls = {
        [secured]: this.urlPrefix,
        get authentication ( ) { return this[secured] + '/v1/oauth2/token' },
        get createOrder ( ) { return this[secured] + '/v2/checkout/orders' },
        get captureOrder ( ) { return this[secured] + '/v2/checkout/orders/${id}/capture' }
    }


    /**
     * 更新并返回token
     * @returns {Promise<string>}
     */
    async authentication ( ) {

        const { clientId, clientSecret } = this.#config

        const base64Auth = Buffer.from ( [ clientId, clientSecret ].join ( ':' ) ).toString ( 'base64' )

        const headers = {
            'Accept': 'application/json',
            'Accept-Language': 'zh_CN',
            'Authorization': 'Basic ' + base64Auth,
        }

        const body = 'grant_type=client_credentials'

        const { body: { error, error_description, access_token, expires_in } } = await IO.http ( {
            url: this.urls.authentication,
            headers
        }, body, 'text' )

        if ( error ) throw new Error ( error_description )

        this.#store.token = access_token

        this.#store.tokenExpires = Date.now ( ) + expires_in * 1000

        return access_token
    }


    /**
     * 获取 token 并自动处理过期时间
     * @returns {Promise<string>}
     */
    async getToken ( ) {

        // 未过期时直接返回
        if ( this.#store.tokenExpires > Date.now ( ) ) return this.#store.token

        if ( this.#store.tokenUpdating ) {

            return new Promise ( ( resolve, reject ) => {

                this.once ( 'tokenUpdated', resolve )
                this.once ( 'tokenUpdateFailed', reject )
            } )
        }

        this.#store.tokenUpdating = true

        try {

            const token = await this.authentication ( )

            this.emit ( 'tokenUpdated', token )

            return token
        } catch ( error ) {

            this.emit ( 'tokenUpdateFailed', error )

            throw error
        }
    }



    async genHeaders ( ) {

        const token = await this.getToken ( )

        const headers = {
            Authorization: 'Bearer ' + token
        }

        return headers
    }



    async createOrder ( params ) {

        const { orderId, amount, description, attach, returnUrl, cancelUrl } = params

        const { brandName, currencyCode } = this.#config

        const purchase = {
            reference_id: orderId,
            amount: {
                currency_code: currencyCode,
                value: amount.toFixed ( 2 ),
            },
            description,
        }

        if ( attach ) purchase.custom_id = 'string' === typeof attach ? attach : JSON.stringify ( attach )

        const body = {
            intent: 'CAPTURB',
            purchase_units: [ purchase ],
            application_context: {
                brand_name: brandName,
                return_url: returnUrl,
                cancel_url: cancelUrl,
            }
        }

        const { body: { details, id, links } } = await IO.http ( { 
            url: this.urls.createOrder, 
            headers: await this.genHeaders ( ) 
        }, body )

        if ( details ) {

            const [ { issue } ] = details

            throw new Error ( issue )
        }

        const [ { href: paymentURL } ] = links.filter ( link => link.rel === 'approve' )

        return {
            id, paymentURL
        }
    }



    async captureOrder ( id ) {

        const { body } = await IO.http ( { 
            url: this.urls.captureOrder.replace ( '${id}', id ), 
            headers: await this.genHeaders ( ) 
        }, { } )

        const { status, details } = body

        if ( details ) {

            const [ { issue } ] = details

            throw new Error ( issue )
        }

        if ( status !== 'COMPLETED' ) throw new Error ( 'ORDER_NOT_COMPLETED' )

        return body
    }
}
