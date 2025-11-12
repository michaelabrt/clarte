import { handleGetUser, handleCreateUser } from "./controllers/user-controller";
import { handleGetProduct, handleCreateProduct } from "./controllers/product-controller";
import { initLogger } from "./utils/logger";
import type { Config } from "./types/index";

const config: Config = { debug: true, port: 3000 };
initLogger(config);

export { handleGetUser, handleCreateUser, handleGetProduct, handleCreateProduct };
