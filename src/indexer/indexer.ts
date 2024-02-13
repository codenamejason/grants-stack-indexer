import { Logger } from "pino";
import { PriceProvider } from "../prices/provider.js";
import { Indexer as ChainsauceIndexer } from "chainsauce";
import { Database } from "../database/index.js";

import abis from "./abis/index.js";
import { PublicClient } from "viem";

export interface EventHandlerContext {
  chainId: number;
  db: Database;
  ipfsGet: <T>(cid: string) => Promise<T | undefined>;
  rpcClient: PublicClient;
  priceProvider: PriceProvider;
  logger: Logger;
}

export type Indexer = ChainsauceIndexer<typeof abis, EventHandlerContext>;
