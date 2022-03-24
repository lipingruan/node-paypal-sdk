
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

        // paypal 应用详情内 sandbox webhooks 可查看
        webhookId: '',

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
        get createOrder    ( ) { return this[secured] + '/v2/checkout/orders' },
        get getOrder       ( ) { return this[secured] + '/v2/checkout/orders/${id}' },
        get captureOrder   ( ) { return this[secured] + '/v2/checkout/orders/${id}/capture' },
        get getCapture     ( ) { return this[secured] + '/v2/payments/captures/${id}' },
        get refundCapture  ( ) { return this[secured] + '/v2/payments/captures/${id}/refund' },
        get getRefunds     ( ) { return this[secured] + '/v2/payments/refunds/${id}' },
        get webhookVerify  ( ) { return this[secured] + '/v1/notifications/verify-webhook-signature' },
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



    /**
     * webhook notification signature verification
     * @param headers
     * @param event
     * @returns {Promise<boolean>}
     */
    async webhookVerify ( headers, event ) {

        const { webhookId } = this.#config

        const body = {
            transmission_id: headers [ 'paypal-transmission-id' ],
            transmission_time: headers [ 'paypal-transmission-time' ],
            cert_url: headers [ 'paypal-cert-url' ],
            auth_algo: headers [ 'paypal-auth-algo' ],
            transmission_sig: headers [ 'paypal-transmission-sig' ],
            webhook_id: webhookId,
            webhook_event: event
        }

        const { body: { verification_status } } = await IO.http ( {
            url: this.urls.webhookVerify,
            headers: await this.genHeaders ( )
        }, body )

        return verification_status === 'SUCCESS'
    }



    /**
     * 创建支付订单
     * @param params
     * @param {string} params.orderId 订单号
     * @param {number} params.amount 交易金额
     * @param {string} params.description 交易描述
     * @param {*} params.attach 回调附加参数
     * @param {string} params.returnUrl 付款成功页面
     * @param {string} params.cancelUrl 取消付款页面
     * @returns {Promise<{id: string, paymentURL:string}>}
     */
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
            intent: 'CAPTURE',
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



    /**
     * 确认收款
     * @param {string} id 订单号
     * @returns {Promise<*>}
     */
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



    /**
     * Show order details
     * @param {string} id order id
     * @returns {Promise<*>}
     */
    async getOrder ( id ) {

        const { body } = await IO.http ( {
            url: this.urls.getOrder.replace ( '${id}', id ),
            headers: await this.genHeaders ( )
        } )

        return body
    }



    /**
     * Show captured payment details
     * @param {string} id capture id
     * @returns {Promise<*>}
     */
    async getCapture ( id ) {

        const { body } = await IO.http ( {
            url: this.urls.getCapture.replace ( '${id}', id ),
            headers: await this.genHeaders ( )
        } )

        return body
    }



    /**
     * Refund captured payment
     * @param {string} id capture id
     * @param {number|{value:string,currency_code:string}} amount refund amount
     * @returns {Promise<*>}
     */
    async refundCapture ( id, amount ) {

        const { currencyCode } = this.#config

        const params = {
            amount: 'number' === typeof amount ? {
                value: amount.toFixed ( 2 ),
                currency_code: currencyCode
            } : amount
        }

        const { body } = await IO.http ( {
            url: this.urls.refundCapture.replace ( '${id}', id ),
            headers: await this.genHeaders ( )
        }, params )

        return body
    }



    /**
     * Show refund details
     * @param id refund id
     * @returns {Promise<*>}
     */
    async getRefunds ( id ) {

        const { body } = await IO.http ( {
            url: this.urls.getRefunds.replace ( '${id}', id ),
            headers: await this.genHeaders ( )
        } )

        return body
    }
}
