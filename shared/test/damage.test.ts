import { describe, expect, it } from "vitest";
import {
  CAR_DAMAGE_MIN, DAMAGE_LOST, botInput, makeBrain, DT, PIT_REPAIR_BASE, PIT_REPAIR_LOST, PIT_REPAIR_PER, SAMPLE_DESIGN, WALL_DAMAGE_MIN, applyImpact, bodyOf,
  computeStats, createCar, damageCount, damageEffect, getTrack, isWrecked, newLapState, packDamage, pushApart, readDamage, repairTime,
  requestPit, serviceTime, stepCar, updateBotPit, updateLaps, type CarState,
} from "../src/index.ts";

const track = getTrack("aozu");
const stats = computeStats(SAMPLE_DESIGN);
const layout = stats.layout!;
const idxOf = (id: string, r: number) => SAMPLE_DESIGN.parts.findIndex((p) => p.id === id && p.r === r);
const FRONT_WING = idxOf("wing_s1", 0);
const REAR_WING = idxOf("wing_s1", 10);

/** 真ん中に置いた、右へ向いた車 */
function freshCar(): CarState {
  const car = createCar(track, stats, 0);
  car.heading = 0;
  return car;
}

describe("傷み: 部品の表", () => {
  it("部品ごとの位置と割合がある (種類ごとの割合の合計は 1)", () => {
    expect(layout.length).toBe(SAMPLE_DESIGN.parts.length);
    for (const kind of ["tire", "wing", "engine", "brake"] as const) {
      const sum = layout.filter((p) => p.kind === kind).reduce((a, p) => a + p.share, 0);
      expect(sum, kind).toBeCloseTo(1, 6);
    }
    // 前の羽根は前に、後ろの羽根は後ろに
    expect(layout[FRONT_WING].lf).toBeGreaterThan(1.5);
    expect(layout[REAR_WING].lf).toBeLessThan(-1.5);
  });
});

describe("傷み: 当たった場所の部品", () => {
  it("前から当たると前の羽根、後ろからだと後ろの羽根が傷む。しきいより弱いと傷まない", () => {
    const car = freshCar();
    expect(applyImpact(car, stats, 1, 0, WALL_DAMAGE_MIN - 0.5)).toBeNull();
    const a = applyImpact(car, stats, 1, 0, 12)!;
    expect(a.part).toBe(FRONT_WING);
    expect(a.kind).toBe("wing");
    const b = applyImpact(car, stats, -1, 0, 12)!;
    expect(b.part).toBe(REAR_WING);
    expect(car.damage!.parts[FRONT_WING]).toBeGreaterThan(0.4);
    expect(car.damage!.parts[FRONT_WING]).toBeLessThan(1);
  });

  it("弱りきると働かず、もう一度強く当たると外れて落ちる (軽くなる・抵抗が減る)", () => {
    const car = freshCar();
    applyImpact(car, stats, 1, 0, 30);
    expect(car.damage!.parts[FRONT_WING]).toBe(1);
    const e1 = damageEffect(car, stats);
    // 羽根 2 つのうち 1 つが働かない → 押しつけは半分
    expect(e1.down).toBeCloseTo(0.5, 6);
    expect(e1.mass).toBe(0);
    const ev = applyImpact(car, stats, 1, 0, 15)!;
    expect(ev.lost).toBe(true);
    expect(car.damage!.parts[FRONT_WING]).toBe(DAMAGE_LOST);
    const e2 = damageEffect(car, stats);
    expect(e2.mass).toBeGreaterThan(0);
    expect(e2.drag).toBeGreaterThan(0);
    expect(damageCount(car)).toEqual({ damaged: 1, broken: 1, lost: 1 });
    // 落ちた部品の次に近い部品が次の当たりを受ける
    const next = applyImpact(car, stats, 1, 0, 10)!;
    expect(next.part).not.toBe(FRONT_WING);
  });

  it("タイヤ・エンジン・ブレーキが傷むと 握り・力・ブレーキが落ちる", () => {
    const car = freshCar();
    car.damage = { parts: layout.map((p) => (p.kind === "tire" || p.kind === "engine" || p.kind === "brake" ? 0.5 : 0)), hits: 0 };
    const e = damageEffect(car, stats);
    expect(e.grip).toBeLessThan(1);
    expect(e.grip).toBeGreaterThan(0.8);
    expect(e.power).toBeCloseTo(1 - 0.35 * 0.5, 6);
    expect(e.brake).toBeLessThan(1);
  });

  it("運転席が壊れたら走れず、止まるとリタイア", () => {
    const car = freshCar();
    const seat = layout.findIndex((p) => p.kind === "seat");
    // 運転席の傷みを 1 手前まで (ほかの部品は無傷) にして、運転席の真横から当てる
    car.damage = { parts: layout.map((_, i) => (i === seat ? 0.99 : 0)), hits: 0 };
    const sideDir = layout[seat].lx >= 0 ? 1 : -1;
    // 右 (法線) の向き = 車が右 (heading 0) を向いているので 画面の下 (+y)
    applyImpact(car, stats, 0, sideDir, 9);
    const target = car.damage.parts.findIndex((h) => h > 0.99);
    if (target === seat) {
      expect(car.damage.out).toBe(true);
    } else {
      // 横に別の部品があれば、直接こわす
      car.damage.parts[seat] = 1;
      car.damage.out = true;
    }
    expect(isWrecked(car, stats)).toBe(true);
    car.started = true;
    car.vx = 10;
    const st = newLapState();
    let retired = false;
    for (let i = 0; i < 60 * 20 && !retired; i++) {
      const ev = stepCar(car, { steer: 0, throttle: 1, brake: 0 }, stats, track, DT);
      retired = !!updateLaps(car, st, ev, i * DT, track.length, 5, false).retired;
    }
    expect(retired).toBe(true);
  });
});

describe("傷み: 壁と車", () => {
  it("壁にまっすぐ強く当たると、当たった側の部品が傷む (env.damage = false なら傷まない)", () => {
    for (const on of [true, false]) {
      const car = createCar(track, stats, 0);
      car.started = true;
      // 道の向きに対して右 (法線の向き) へ 25 m/s で走らせる
      car.heading += Math.PI / 2;
      car.vx = Math.cos(car.heading) * 25;
      car.vy = Math.sin(car.heading) * 25;
      let hit = null;
      for (let i = 0; i < 120 && !hit; i++) {
        const ev = stepCar(car, { steer: 0, throttle: 1, brake: 0 }, stats, track, DT, { damage: on });
        if (ev.damage) hit = ev.damage;
        if (ev.wall && !on) break;
      }
      if (on) {
        expect(hit).not.toBeNull();
        expect(hit!.part).toBe(FRONT_WING);
        expect(car.damage!.parts[FRONT_WING]).toBeGreaterThan(0);
      } else {
        expect(hit).toBeNull();
        expect(damageCount(car).damaged).toBe(0);
      }
    }
  });

  it("車どうし: stats を渡すと強くぶつかった側が傷む。軽く触れただけなら傷まない", () => {
    const a = freshCar();
    const b = freshCar();
    b.x = a.x + stats.length * 0.8;
    b.y = a.y;
    // a が後ろから追突
    a.vx = 20;
    b.vx = 20 - (CAR_DAMAGE_MIN + 6);
    const hit = pushApart(a, bodyOf(a, stats), bodyOf(b, stats), 0.5, stats);
    expect(hit).toBeGreaterThan(CAR_DAMAGE_MIN);
    expect(a.damage!.parts[FRONT_WING]).toBeGreaterThan(0);

    const c = freshCar();
    const d = freshCar();
    d.x = c.x + stats.length * 0.8;
    c.vx = 20;
    d.vx = 18;
    pushApart(c, bodyOf(c, stats), bodyOf(d, stats), 0.5, stats);
    expect(damageCount(c).damaged).toBe(0);
    // stats を渡さなければ これまでどおり傷まない
    const e = freshCar();
    const f = freshCar();
    f.x = e.x + stats.length * 0.8;
    e.vx = 30;
    pushApart(e, bodyOf(e, stats), bodyOf(f, stats), 0.5);
    expect(e.damage ?? null).toBeNull();
  });
});

describe("傷み: ピットの修理", () => {
  it("修理の時間は 傷んだ部品の数で決まり、修理すると全部直る", () => {
    const car = freshCar();
    expect(repairTime(car)).toBe(0);
    applyImpact(car, stats, 1, 0, 30);
    applyImpact(car, stats, 1, 0, 30);
    applyImpact(car, stats, -1, 0, 10);
    const n = damageCount(car);
    expect(n.damaged).toBe(2);
    expect(n.lost).toBe(1);
    expect(repairTime(car)).toBeCloseTo(PIT_REPAIR_BASE + PIT_REPAIR_PER * 2 + PIT_REPAIR_LOST, 6);
    expect(serviceTime(car, stats, { repair: true })).toBeCloseTo(repairTime(car), 6);
    expect(serviceTime(car, stats, { repair: false })).toBe(0);

    // コンピューターに走らせて、ピットに入って直す
    const c2 = createCar(track, stats, 0);
    c2.started = true;
    c2.damage = { parts: car.damage!.parts.slice(), hits: 2 };
    requestPit(c2, { repair: true });
    const brain = makeBrain(() => 0.5, 0.9);
    let stopped = 0;
    for (let i = 0; i < 60 * 90 && damageCount(c2).damaged > 0; i++) {
      stepCar(c2, botInput(c2, stats, track, brain, i * DT), stats, track, DT);
      if (c2.pit?.phase === "box") stopped += DT;
    }
    expect(damageCount(c2).damaged).toBe(0);
    expect(c2.damage!.hits).toBe(2);
    expect(stopped).toBeGreaterThan(repairTime(car) - 0.1);
  });
});

describe("傷み: コンピューター", () => {
  it("壊れた部品があれば 修理の予約をする。小さな傷だけなら入らない", () => {
    const brain = makeBrain(() => 0.5, 0.9);
    const info = { totalLaps: 5, wetNow: 0, wetSoon: 0 };
    const small = createCar(track, stats, 0, { fuel: stats.fuelCap });
    small.started = true;
    small.dist = 50;
    applyImpact(small, stats, 1, 0, 8);
    updateBotPit(small, stats, track, brain, info);
    expect(small.pitOrder ?? null).toBeNull();
    const broken = createCar(track, stats, 0, { fuel: stats.fuelCap });
    broken.started = true;
    broken.dist = 50;
    applyImpact(broken, stats, 1, 0, 30);
    updateBotPit(broken, stats, track, makeBrain(() => 0.5, 0.9), info);
    expect(broken.pitOrder?.repair).toBe(true);
  });
});

describe("傷み: やりとり", () => {
  it("packDamage / readDamage で同じ傷みに戻る。おかしな値は捨てる", () => {
    const car = freshCar();
    expect(packDamage(car.damage)).toBeUndefined();
    applyImpact(car, stats, 1, 0, 30);
    applyImpact(car, stats, 1, 0, 30);
    applyImpact(car, stats, -1, 0, 13);
    const packed = packDamage(car.damage)!;
    const back = readDamage(packed, car.damage!.hits, stats);
    expect(back.parts).toEqual(packed);
    expect(back.hits).toBe(car.damage!.hits);
    expect(readDamage([1, 2, 3], 1, stats).parts.every((h) => h === 0)).toBe(true);
    expect(readDamage(packed.map(() => 99), "x", stats).parts.every((h) => h === DAMAGE_LOST)).toBe(true);
  });
});
