import { Inject } from "@nestjs/common";

import { ATTIC_CLIENT, ATTIC_ENGINE, ATTIC_WORKER } from "./tokens.js";

export const InjectAtticClient = (): ParameterDecorator & PropertyDecorator => Inject(ATTIC_CLIENT);

export const InjectAtticEngine = (): ParameterDecorator & PropertyDecorator => Inject(ATTIC_ENGINE);

export const InjectAtticWorker = (): ParameterDecorator & PropertyDecorator => Inject(ATTIC_WORKER);
