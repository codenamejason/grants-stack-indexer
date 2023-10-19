import { Logger } from "pino";
import { getChainConfigById } from "../config.js";
import {
  Price,
  PriceWithDecimals,
  readPricesFile,
  UnknownTokenError,
} from "./common.js";
import { convertTokenToFiat, convertFiatToToken } from "../tokenMath.js";

const DEFAULT_REFRESH_PRICE_INTERVAL_MS = 10000;

interface PriceProviderConfig {
  updateEveryMs?: number;
  storageDir: string;
  logger: Logger;
}

export interface PriceProvider {
  convertToUSD: (
    chainId: number,
    token: string,
    amount: bigint,
    blockNumber?: number
  ) => Promise<{ amount: number; price: number }>;
  convertFromUSD: (
    chainId: number,
    token: string,
    amount: number,
    blockNumber?: number
  ) => Promise<{ amount: bigint; price: number }>;
  getAllPricesForChain: (chainId: number) => Promise<Price[]>;
  getUSDConversionRate: (
    chainId: number,
    tokenAddress: string,
    blockNumber?: number
  ) => Promise<PriceWithDecimals>;
}

export function createPriceProvider(
  config: PriceProviderConfig
): PriceProvider {
  const { logger: _logger } = config;

  // STATE

  type Prices = { lastUpdatedAt: Date; prices: Promise<Price[]> };

  const prices: { [key: number]: Prices } = {};

  // PUBLIC

  async function getAllPricesForChain(chainId: number): Promise<Price[]> {
    return readPricesFile(chainId, config.storageDir);
  }

  // INTERNALS

  function shouldRefreshPrices(prices: Prices) {
    return (
      new Date().getTime() - prices.lastUpdatedAt.getTime() >
      (config.updateEveryMs ?? DEFAULT_REFRESH_PRICE_INTERVAL_MS)
    );
  }

  function updatePrices(chainId: number) {
    const chainPrices = readPricesFile(chainId, config.storageDir);

    prices[chainId] = {
      prices: chainPrices,
      lastUpdatedAt: new Date(),
    };

    return chainPrices;
  }

  async function getPrices(chainId: number): Promise<Price[]> {
    if (!(chainId in prices) || shouldRefreshPrices(prices[chainId])) {
      await updatePrices(chainId);
    }

    return prices[chainId].prices;
  }

  async function convertToUSD(
    chainId: number,
    token: string,
    amount: bigint,
    blockNumber?: number
  ): Promise<{ amount: number; price: number }> {
    const closestPrice = await getUSDConversionRate(
      chainId,
      token,
      blockNumber
    );

    return {
      amount: convertTokenToFiat({
        tokenAmount: amount,
        tokenDecimals: closestPrice.decimals,
        tokenPrice: closestPrice.price,
        tokenPriceDecimals: 8,
      }),
      price: closestPrice.price,
    };
  }

  async function convertFromUSD(
    chainId: number,
    token: string,
    amountInUSD: number,
    blockNumber?: number
  ): Promise<{ amount: bigint; price: number }> {
    const closestPrice = await getUSDConversionRate(
      chainId,
      token,
      blockNumber
    );

    return {
      amount: convertFiatToToken({
        fiatAmount: amountInUSD,
        tokenPrice: closestPrice.price,
        tokenPriceDecimals: 8,
        tokenDecimals: closestPrice.decimals,
      }),
      price: 1 / closestPrice.price, // price is the token price in USD, we return the inverse
    };
  }

  async function getUSDConversionRate(
    chainId: number,
    tokenAddress: string,
    blockNumber?: number
  ): Promise<Price & { decimals: number }> {
    let closestPrice: Price | null = null;

    const chain = getChainConfigById(chainId);

    const token = chain.tokens.find(
      (t) => t.address.toLowerCase() === tokenAddress.toLowerCase()
    );
    if (token === undefined) {
      throw new UnknownTokenError(tokenAddress, chainId);
    }

    const pricesForToken = (await getPrices(chainId)).filter(
      (p) => p.token === tokenAddress
    );
    if (pricesForToken.length === 0) {
      throw new Error(
        `No prices found for token ${tokenAddress} on chain ${chainId} at ${String(
          blockNumber
        )}`
      );
    }

    const firstAvailablePrice = pricesForToken.at(0)!;
    const lastAvailablePrice = pricesForToken.at(-1)!;

    if (blockNumber === undefined) {
      closestPrice = lastAvailablePrice;
    } else if (blockNumber > lastAvailablePrice.block) {
      // TODO decide how to warn about potential inconsistencies without spamming
      // logger.warn(
      //   `requested price for block ${blockNumber} newer than last available ${lastAvailablePrice.block}`
      // );
      closestPrice = lastAvailablePrice;
    } else if (blockNumber < firstAvailablePrice.block) {
      // TODO decide how to warn about potential inconsistencies without spamming
      // logger.warn(
      //   `requested price for block ${blockNumber} older than earliest available ${firstAvailablePrice.block}`
      // );
      closestPrice = firstAvailablePrice;
    } else {
      closestPrice =
        pricesForToken.reverse().find((p) => p.block < blockNumber) ?? null;
    }

    if (closestPrice === null) {
      throw Error(
        `Price not found for token ${tokenAddress} on chain ${chainId}`
      );
    }

    return { ...closestPrice, decimals: token.decimals };
  }

  return {
    convertToUSD,
    convertFromUSD,
    getAllPricesForChain,
    getUSDConversionRate,
  };
}
