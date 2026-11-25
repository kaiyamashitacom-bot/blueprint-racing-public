// セクター (区間タイム) (11/25 ユーザー「セクターも分けれる様にして」)。
// 1 周を 3 つ (S1・S2・S3) に分け、区間ごとのタイムを出す。切れ目はコースの sectors (周の割合 2 つ)、書かなければ 3 等分。
// 旗の黄旗の区間 (racecontrol.ts の FLAG_SECTORS = 10 区間) とは別のもの。
// 切れ目を通った時刻は、前後の記録 (時刻と道のり) の間をまっすぐ割って出す (timing.ts の印と同じやり方)。
// 自分の車は毎刻み、ほかの車は snap (道のりと時刻) から、画面で数える。数は全部 (仮)。
import { ghostTimeAt, type GhostProfile } from "./timing.ts";
import type { Track, TrackDef } from "./track.ts";

/** 1 周のセクターの数 */
export const LAP_SECTORS = 3;
/** 1 つのセクターの一番短い長さ (1 周の割合、仮) */
export const SECTOR_MIN_FRACTION = 0.1;
/** 書いていないときの切れ目 (3 等分) */
export const DEFAULT_SECTOR_SPLITS: readonly [number, number] = [1 / 3, 2 / 3];
/** 同じタイムとみる幅 (秒)。1/1000 秒の字で同じなら同じ */
const SAME = 0.0005;
/** 記録の間がこの速さ (m/s) より速い (つなぎ直しで飛んだなど) なら、その間の切れ目の時刻は分からないとみる (仮。540 km/h) */
const MAX_JUMP_SPEED = 150;

/** 切れ目 (周の割合 2 つ) の問題 (なければ null) */
export function sectorSplitProblem(splits: unknown): string | null {
  if (!Array.isArray(splits) || splits.length !== LAP_SECTORS - 1 || !splits.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return "セクターの切れ目が読めません";
  }
  const edges = [0, ...(splits as number[]), 1];
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] - edges[i - 1] < SECTOR_MIN_FRACTION - 1e-9) {
      return `セクターの切れ目は順に並べ、1 つのセクターを 1 周の ${Math.round(SECTOR_MIN_FRACTION * 100)}% 以上に`;
    }
  }
  return null;
}

/** コースの切れ目 (周の割合 2 つ)。書いていない・おかしいときは 3 等分 */
export function sectorSplits(def: Pick<TrackDef, "sectors">): [number, number] {
  const s = def.sectors;
  if (s !== undefined && sectorSplitProblem(s) === null) return [s[0], s[1]];
  return [DEFAULT_SECTOR_SPLITS[0], DEFAULT_SECTOR_SPLITS[1]];
}

/** 切れ目の道のり (周の始まりから m) */
export function sectorSplitDistances(track: Track): [number, number] {
  const [a, b] = sectorSplits(track.def);
  return [a * track.length, b * track.length];
}

/** コースの道のり s (m、周をまたいでもよい) が何番目のセクターか (0..2) */
export function lapSectorAt(track: Track, s: number): number {
  const L = track.length;
  const f = (((s % L) + L) % L) / L;
  const [a, b] = sectorSplits(track.def);
  return f >= b ? 2 : f >= a ? 1 : 0;
}

/** 1 周のセクターのタイム (秒。まだ・分からないは null) と、数えてよいか (近道した周のあとは false) */
export interface LapSectors {
  times: Array<number | null>;
  valid: boolean[];
}

/** 切れ目を通ったとき (push の答え) */
export interface SectorCross {
  /** 走り終えた周の数 (この周は lap + 1 周目) */
  lap: number;
  /** 終えたセクター (0..2) */
  sector: number;
  /** そのセクターのタイム (秒) */
  time: number;
  /** 通った時刻 (秒) */
  at: number;
  valid: boolean;
}

/**
 * 1 台のセクターのタイム。push(時刻, 道のり) を順に渡す (道のりは スタートの線 = 0 で増えていく car.dist)。
 * raceStart を渡すと、スタートの線の手前 (道のり < 0) から走り出した 1 周目の S1 はその時刻から数える
 * (1 周目の周の時間が信号の合図から数えるのと合わせる)。lineAtPush は下に。
 */
export class SectorTimer {
  /** 周ごと (走り終えた周の数 → 3 つのタイム) */
  readonly laps = new Map<number, LapSectors>();
  /** 自分の一番速いセクター (数えてよいものだけ) */
  readonly best: Array<number | null> = [null, null, null];
  private readonly edges: [number, number, number];
  private lastT = NaN;
  private lastD = NaN;
  /** 最後に通った切れ目の番号 (周 × 3 + セクター) と時刻 (分からなければ null) */
  private curJ = -Infinity;
  private curT: number | null = null;

  constructor(
    readonly trackLength: number,
    splits: readonly number[] = DEFAULT_SECTOR_SPLITS,
    readonly raceStart: number | null = 0,
    /**
     * スタートの線 (周の切れ目) は、越えた記録の時刻そのもので数える (割らない)。
     * 自分の車は周の時間を刻みの終わりで数える (race.ts の updateLaps) ので、こうすると 3 つの合計が周の時間とぴったり合う
     */
    readonly lineAtPush = false,
  ) {
    const s = sectorSplitProblem(splits) === null ? splits : DEFAULT_SECTOR_SPLITS;
    this.edges = [0, s[0], s[1]];
  }

  /** 切れ目 j の道のり */
  private distOf(j: number): number {
    const lap = Math.floor(j / LAP_SECTORS);
    return (lap + this.edges[j - lap * LAP_SECTORS]) * this.trackLength;
  }

  /** 道のり d より手前で一番近い切れ目の番号 */
  private jOf(d: number): number {
    const L = this.trackLength;
    const lap = Math.floor(d / L);
    const f = d / L - lap;
    const k = f >= this.edges[2] ? 2 : f >= this.edges[1] ? 1 : 0;
    return lap * LAP_SECTORS + k;
  }

  /** 時刻 t (秒) に道のり dist (m) にいた。越えた切れ目を返す (valid = 今の周を数えてよいか) */
  push(t: number, dist: number, valid = true): SectorCross[] {
    const out: SectorCross[] = [];
    if (!Number.isFinite(t) || !Number.isFinite(dist)) return out;
    if (!Number.isFinite(this.lastD)) {
      this.lastT = t;
      this.lastD = dist;
      this.curJ = this.jOf(dist);
      // ちょうど切れ目の上から走り出したら、そこから数える
      if (Math.abs(this.distOf(this.curJ) - dist) < 1e-9) this.curT = t;
      // スタートの線の手前から: 1 周目の S1 は合図から
      if (dist < 0 && this.raceStart !== null) {
        this.curJ = 0;
        this.curT = this.raceStart;
      }
      return out;
    }
    if (dist <= this.lastD) {
      // 下がった・止まった: 一番先まで行った場所は変えず、時刻だけ進める
      this.lastT = Math.max(this.lastT, t);
      return out;
    }
    const jump = dist - this.lastD > MAX_JUMP_SPEED * Math.max(0, t - this.lastT) + 1;
    const j1 = this.jOf(dist);
    for (let j = this.jOf(this.lastD) + 1; j <= j1; j++) {
      if (j <= this.curJ) continue; // スタートの線 (合図から数えている)
      const bd = this.distOf(j);
      const at = jump ? NaN : this.lineAtPush && j % LAP_SECTORS === 0 ? t : this.lastT + ((t - this.lastT) * (bd - this.lastD)) / (dist - this.lastD);
      if (this.curT !== null && this.curJ === j - 1 && Number.isFinite(at)) {
        const prev = j - 1;
        const lap = Math.floor(prev / LAP_SECTORS);
        const sector = prev - lap * LAP_SECTORS;
        const time = at - this.curT;
        this.record(lap, sector, time, valid);
        out.push({ lap, sector, time, at, valid });
      }
      this.curJ = j;
      this.curT = Number.isFinite(at) ? at : null;
    }
    this.lastT = t;
    this.lastD = dist;
    return out;
  }

  private record(lap: number, sector: number, time: number, valid: boolean) {
    let l = this.laps.get(lap);
    if (!l) this.laps.set(lap, (l = { times: [null, null, null], valid: [true, true, true] }));
    l.times[sector] = time;
    l.valid[sector] = valid;
    if (valid) {
      const b = this.best[sector];
      if (b === null || time < b) this.best[sector] = time;
    }
  }

  /** 今走っているセクター (周・セクター・始まりの時刻。始まりが分からなければ start は null) */
  current(): { lap: number; sector: number; start: number | null } | null {
    if (!Number.isFinite(this.curJ)) return null;
    const lap = Math.floor(this.curJ / LAP_SECTORS);
    return { lap, sector: this.curJ - lap * LAP_SECTORS, start: this.curT };
  }

  /** 周 lap のタイム (なければ null) */
  lap(lap: number): LapSectors | null {
    return this.laps.get(lap) ?? null;
  }

  /** 一番速いセクターの合計 (理論上の一番速い周。3 つそろわなければ null) */
  ideal(): number | null {
    return idealLap(this.best);
  }

  /** 周ごとのタイムを JSON にできる形で (走った線の記録に付ける) */
  toRecord(): Record<number, Array<number | null>> {
    const out: Record<number, Array<number | null>> = {};
    for (const [k, v] of this.laps) out[k] = v.times.map((x, i) => (x === null || !v.valid[i] ? null : Math.round(x * 1000) / 1000));
    return out;
  }
}

/** 一番速いセクターの合計 (3 つそろわなければ null) */
export function idealLap(best: ReadonlyArray<number | null>): number | null {
  if (best.length < LAP_SECTORS) return null;
  let sum = 0;
  for (let i = 0; i < LAP_SECTORS; i++) {
    const b = best[i];
    if (b === null || b === undefined || !Number.isFinite(b)) return null;
    sum += b;
  }
  return sum;
}

/** その場の全員で一番速いセクター (セクターごとに タイムと車の id。まだなければ null) */
export function sessionBestSectors(cars: Iterable<{ id: string; best: ReadonlyArray<number | null> }>): Array<{ time: number; id: string } | null> {
  const out: Array<{ time: number; id: string } | null> = [null, null, null];
  for (const c of cars) {
    for (let i = 0; i < LAP_SECTORS; i++) {
      const b = c.best[i];
      if (b === null || b === undefined || !Number.isFinite(b)) continue;
      const cur = out[i];
      if (!cur || b < cur.time - SAME) out[i] = { time: b, id: c.id };
    }
  }
  return out;
}

/** セクターの色: 紫 = その場で一番・緑 = 自己ベスト・黄 = 遅い・灰 = 数えない */
export type SectorColor = "purple" | "green" | "yellow" | "void";

export function sectorColor(time: number, valid: boolean, pb: number | null, sessionBest: number | null): SectorColor {
  if (!valid) return "void";
  if (sessionBest !== null && time <= sessionBest + SAME) return "purple";
  if (pb === null || time <= pb + SAME) return "green";
  return "yellow";
}

/** 幽霊の 1 周のセクターのタイム (分からなければ null) */
export function ghostSectorTimes(p: GhostProfile, track: Track): Array<number | null> {
  const [a, b] = sectorSplitDistances(track);
  const pts = [0, a, b, track.length].map((d) => ghostTimeAt(p, d));
  const out: Array<number | null> = [];
  for (let i = 0; i < LAP_SECTORS; i++) {
    const x = pts[i];
    const y = pts[i + 1];
    out.push(x === null || y === null ? null : y - x);
  }
  return out;
}

/** セクターのタイムの字 (60 秒より下は 23.456、上は 1:02.345) */
export function formatSector(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "--.---";
  if (sec < 60) return sec.toFixed(3);
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(3).padStart(6, "0")}`;
}

/** 差の字 (+0.123 / −0.123) */
export function formatSectorDelta(d: number): string {
  return `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(3)}`;
}
