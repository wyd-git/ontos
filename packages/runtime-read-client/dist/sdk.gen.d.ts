import type { Client, ClientMeta, Options as Options2, RequestResult, TDataShape } from './client/index.js';
import type { CountRuntimeObjectsData, CountRuntimeObjectsErrors, CountRuntimeObjectsResponses, GetRuntimeMetadataData, GetRuntimeMetadataErrors, GetRuntimeMetadataResponses, GetRuntimeObjectData, GetRuntimeObjectErrors, GetRuntimeObjectResponses, SearchRuntimeLinksData, SearchRuntimeLinksErrors, SearchRuntimeLinksResponses, SearchRuntimeObjectsData, SearchRuntimeObjectsErrors, SearchRuntimeObjectsResponses } from './types.gen.js';
export type Options<TData extends TDataShape = TDataShape, ThrowOnError extends boolean = boolean, TResponse = unknown> = Options2<TData, ThrowOnError, TResponse> & {
    /**
     * You can provide a client instance returned by `createClient()` instead of
     * individual options. This might be also useful if you want to implement a
     * custom client.
     */
    client?: Client;
    /**
     * You can pass arbitrary values through the `meta` object. This can be
     * used to access values that aren't defined as part of the SDK function.
     */
    meta?: keyof ClientMeta extends never ? Record<string, unknown> : ClientMeta;
};
export declare const getRuntimeMetadata: <ThrowOnError extends boolean = false>(options: Options<GetRuntimeMetadataData, ThrowOnError>) => RequestResult<GetRuntimeMetadataResponses, GetRuntimeMetadataErrors, ThrowOnError>;
export declare const getRuntimeObject: <ThrowOnError extends boolean = false>(options: Options<GetRuntimeObjectData, ThrowOnError>) => RequestResult<GetRuntimeObjectResponses, GetRuntimeObjectErrors, ThrowOnError>;
export declare const searchRuntimeObjects: <ThrowOnError extends boolean = false>(options: Options<SearchRuntimeObjectsData, ThrowOnError>) => RequestResult<SearchRuntimeObjectsResponses, SearchRuntimeObjectsErrors, ThrowOnError>;
export declare const countRuntimeObjects: <ThrowOnError extends boolean = false>(options: Options<CountRuntimeObjectsData, ThrowOnError>) => RequestResult<CountRuntimeObjectsResponses, CountRuntimeObjectsErrors, ThrowOnError>;
export declare const searchRuntimeLinks: <ThrowOnError extends boolean = false>(options: Options<SearchRuntimeLinksData, ThrowOnError>) => RequestResult<SearchRuntimeLinksResponses, SearchRuntimeLinksErrors, ThrowOnError>;
