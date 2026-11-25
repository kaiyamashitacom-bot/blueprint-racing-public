// 版の印。__BPR_BUILD__ は組み立てのときに vite.config.ts の define が git の短い番号を入れる (試験など define の無いところは "dev")
declare const __BPR_BUILD__: string | undefined;

/** 画面に出す版 (メニューの札と同じ) */
export const APP_VERSION = "v0.2";
export const BUILD_ID: string = typeof __BPR_BUILD__ === "string" ? __BPR_BUILD__ : "dev";
