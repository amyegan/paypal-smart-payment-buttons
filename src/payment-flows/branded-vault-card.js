/* @flow */

import { noop } from 'belter/src';
import { ZalgoPromise } from 'zalgo-promise/src';
import { FUNDING } from '@paypal/sdk-constants/src/funding';

import { payWithPaymentMethodToken, loadFraudnet, upgradeFacilitatorAccessToken } from '../api';
import { getLogger, promiseNoop, getBuyerAccessToken } from '../lib';
import type { ButtonProps } from '../button/props';

import type { PaymentFlow, PaymentFlowInstance } from './types';
import { checkout } from './checkout';

const ERROR_CODE = {
    PAY_WITH_DIFFERENT_CARD: 'PAY_WITH_DIFFERENT_CARD'
};

function getClientMetadataID({ props } : {| props : ButtonProps |}) : string {
    const { clientMetadataID, sessionID } = props;
    return clientMetadataID || sessionID;
}

function setupBrandedVaultCard({ props, config }) {
    const { env } = props;
    const { cspNonce } = config;
    const clientMetadataID = getClientMetadataID({ props });
    loadFraudnet({ env, clientMetadataID, cspNonce }).catch(noop);
}

function isBrandedVaultCardEligible({ props, serviceData }) : boolean {
    const { paymentMethodToken, branded } = props;
    const { wallet } = serviceData;

    const instrument  = wallet?.card?.instruments.filter(({ tokenID })  => (tokenID === paymentMethodToken))[0];

    if (!paymentMethodToken) {
        return false;
    }

    if (!wallet) {
        return false;
    }

    if (!instrument) {
        return false;
    }

    if (!branded) {
        return false;
    }

    // Ensure wallet instruments are branded and have a valid tokenID.
    if (wallet.card.instruments.length === 0 ||
        !wallet.card.instruments.some(item => (item.tokenID && item.branded))) {
        return false;
    }

    return true;
}

function isBrandedVaultCardPaymentEligible({ props, payment, serviceData }) : boolean {

    const { branded } = props;
    const { wallet } = serviceData;

    const { fundingSource, paymentMethodID } = payment;

    const instrument  = wallet?.card?.instruments.filter(({ tokenID })  => (tokenID === paymentMethodID))[0];

    if (!instrument) {
        return false;
    }

    if (fundingSource !== FUNDING.CARD) {
        return false;
    }
    
    if (!branded || !instrument.branded) {
        return false;
    }

    if (!instrument?.tokenID) {
        return false;
    }

    return true;
}

function approveOrder({ orderID, paymentMethodToken, clientID, branded, buttonSessionID, clientMetadataID }) : ZalgoPromise<{| payerID : string |}> {
    getLogger().info('branded_vault_card_payment_initiated');

    if (!branded) {
        throw new Error(`Expected payment to be branded`);
    }

    return payWithPaymentMethodToken({ orderID, paymentMethodToken, clientID, branded, buttonSessionID, clientMetadataID })
        .catch((error) => {
            getLogger().info('branded_vault_card_payment_failed');
            // $FlowFixMe
            error.code = ERROR_CODE.PAY_WITH_DIFFERENT_CARD;
            throw error;
        });
}

// eslint-disable-next-line flowtype/require-return-type
function upgradeLSAT(merchantAccessToken : string, orderID : string) {
    const buyerAccessToken = getBuyerAccessToken();
    // eslint-disable-next-line no-console
    console.log('do the thing', merchantAccessToken, orderID, buyerAccessToken);
                    
    if (!buyerAccessToken) {
        getLogger().error('lsat_upgrade_error', { err: 'buyer access token not found' });
        throw new Error('Buyer access token not found');
    }

    // eslint-disable-next-line no-console
    return upgradeFacilitatorAccessToken(merchantAccessToken, { buyerAccessToken, orderID }).then(() => console.log('success!')).catch(error => console.error('fail...', error));
}

function initBrandedVaultCard({ props, components, payment, serviceData, config }) : PaymentFlowInstance {
    const { createOrder, onApprove, clientID, branded, buttonSessionID, merchantAccessToken } = props;
    const { wallet } = serviceData;
    const { paymentMethodID } = payment;

    const clientMetadataID = getClientMetadataID({ props });
    const instrument  = wallet?.card?.instruments.filter(({ tokenID })  => (tokenID === paymentMethodID))[0];
    const paymentMethodToken = instrument?.tokenID;

    if (!paymentMethodToken) {
        getLogger().info('branded_vault_card_payment_failed');
        throw new Error('PAY_WITH_DIFFERENT_CARD');
    }

    const fallbackToWebCheckout = () => {
        getLogger().info('web_checkout_fallback').flush();
        return checkout.init({
            props, components, serviceData, payment, config
        });
    };

    const restart = () => {
        return fallbackToWebCheckout().start();
    };

    const start = () => {
        return createOrder().then(orderID => {
            return approveOrder({ orderID, paymentMethodToken, clientID, branded, buttonSessionID, clientMetadataID }).then(({ payerID }) => {
                // Need to upgrade LSAT before we go to onApprove using new merchantAccessToken
                if (merchantAccessToken) {
                    return upgradeLSAT(merchantAccessToken, orderID).then(() => {
                        return onApprove({ payerID }, { restart });
                    });
                }
            });
        });
    };

    return {
        start,
        close: promiseNoop
    };
}


export const brandedVaultCard : PaymentFlow = {
    name:              'nonce',
    setup:             setupBrandedVaultCard,
    isEligible:        isBrandedVaultCardEligible,
    isPaymentEligible: isBrandedVaultCardPaymentEligible,
    init:              initBrandedVaultCard,
    inline:            true
};
