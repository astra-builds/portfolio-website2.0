// A tiny multi-cursor choreography engine.
// Cursors are real DOM overlays that build the page in a shared workspace.

export type AgentDef = { id: string; name: string; color: string; ink?: string };

export const AGENTS: AgentDef[] = [
  { id: "planner", name: "planner", color: "#7C3AED" },
  { id: "nav", name: "nav-bot", color: "#2F5BFF" },
  { id: "type", name: "type-smith", color: "#FF4D2E" },
  { id: "pixel", name: "pixel", color: "#FF2E93" },
  { id: "copy", name: "copy-pilot", color: "#00A896" },
  { id: "gallery", name: "curator", color: "#7DC400", ink: "#0E0E0C" },
  { id: "ticker", name: "tick-tock", color: "#FFA400", ink: "#0E0E0C" },
];

export type Task = {
  kind: "build";
  id: string;
  mode?: "drag" | "click" | "type" | "carry";
  fx?: string;
  log: string;
  hold?: number;
};

export type Plan = Record<string, { delay: number; tasks: Task[] }>;

type Hooks = {
  onLog: (agent: AgentDef, text: string) => void;
  onProgress: (done: number, total: number) => void;
  onDone: (ms: number) => void;
};

const ease = {
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  outExpo: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  linear: (t: number) => t,
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

class Cursor {
  el: HTMLDivElement;
  chip: HTMLSpanElement;
  x = -100;
  y = -100;
  epoch = 0;
  constructor(public def: AgentDef, layer: HTMLElement, public eng: Engine) {
    this.el = document.createElement("div");
    this.el.className = "agent-cursor";
    this.el.style.setProperty("--c", def.color);
    this.el.style.setProperty("--ink", def.ink ?? "#fff");
    this.el.innerHTML = `<svg width="22" height="26" viewBox="0 0 22 26" fill="none"><path d="M3 2.5v17.2l4.6-4.2 3.2 7.4 3.1-1.4-3.2-7.2h6.3L3 2.5Z" fill="${def.color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    this.chip = document.createElement("span");
    this.chip.className = "agent-chip";
    this.chip.textContent = def.name;
    this.el.appendChild(this.chip);
    layer.appendChild(this.el);
    this.set(-100, -100);
  }
  set(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.el.style.transform = `translate3d(${x}px,${y}px,0)`;
  }
  interrupt() {
    this.epoch++;
  }
  async moveTo(x: number, y: number, ms?: number, easing = ease.inOut) {
    const ep = this.epoch;
    const x0 = this.x,
      y0 = this.y;
    const dx = x - x0,
      dy = y - y0;
    const dist = Math.hypot(dx, dy) || 1;
    const dur = ms ?? clamp(240 + dist * 0.42, 300, 760);
    const bend = (Math.random() - 0.5) * Math.min(dist * 0.4, 180);
    const cx = x0 + dx / 2 - (dy / dist) * bend;
    const cy = y0 + dy / 2 + (dx / dist) * bend;
    return this.eng.tween(
      dur,
      easing,
      (t) => {
        const u = 1 - t;
        this.set(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
      },
      () => this.epoch === ep
    );
  }
  setLabel(s?: string) {
    this.chip.textContent = s ?? this.def.name;
  }
}

export class Engine {
  // Keeps the full cursor choreography visible while trimming idle time between moves.
  // The animation remains deliberate; it simply reaches the finished canvas sooner.
  readonly tempo = 0.78;
  layer: HTMLDivElement;
  cursors: Record<string, Cursor> = {};
  skipped = false;
  dead = false;
  ambientOn = true;
  waiters = new Set<() => void>();
  gatherEl: HTMLElement | null = null;
  total = 0;
  done = 0;
  t0 = 0;

  constructor(private hooks: Hooks) {
    this.layer = document.createElement("div");
    this.layer.className = "agent-layer";
    document.body.appendChild(this.layer);
    AGENTS.forEach((a) => (this.cursors[a.id] = new Cursor(a, this.layer, this)));
  }

  destroy() {
    this.dead = true;
    this.skip();
    this.layer.remove();
  }

  skip() {
    this.skipped = true;
    this.waiters.forEach((w) => w());
    this.waiters.clear();
  }

  sleep(ms: number) {
    return new Promise<void>((res) => {
      if (this.skipped) return res();
      const w = () => {
        clearTimeout(id);
        res();
      };
      const id = setTimeout(() => {
        this.waiters.delete(w);
        res();
      }, ms * this.tempo);
      this.waiters.add(w);
    });
  }

  tween(ms: number, easing: (t: number) => number, fn: (t: number) => void, alive?: () => boolean) {
    return new Promise<boolean>((res) => {
      if (this.skipped || this.dead) {
        fn(1);
        return res(true);
      }
      const start = performance.now();
      const duration = ms * this.tempo;
      const step = (now: number) => {
        if (this.dead) return res(false);
        if (this.skipped) {
          fn(1);
          return res(true);
        }
        if (alive && !alive()) return res(false);
        const p = clamp((now - start) / duration, 0, 1);
        fn(easing(p));
        if (p < 1) requestAnimationFrame(step);
        else res(true);
      };
      requestAnimationFrame(step);
    });
  }

  private find(id: string) {
    return document.querySelector<HTMLElement>(`[data-build="${id}"]`);
  }

  private vp() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  private markBuilt(el: HTMLElement, fx: string | undefined, agent: AgentDef) {
    el.style.setProperty("--agent", agent.color);
    if (fx) el.dataset.fx = fx;
    el.classList.add("built");
  }

  private tick(agent: AgentDef, text: string) {
    this.done++;
    this.hooks.onLog(agent, text);
    this.hooks.onProgress(this.done, this.total);
  }

  // ---------------------------------------------------------------- tasks
  private async doBuild(cur: Cursor, t: Extract<Task, { kind: "build" }>) {
    const el = this.find(t.id);
    if (!el) {
      this.done++;
      return;
    }
    const { w: vw, h: vh } = this.vp();
    const r = el.getBoundingClientRect();
    const fx = t.fx ?? el.dataset.fx;
    if (this.skipped || r.top > vh - 8 || r.bottom < 0 || r.width < 2) {
      this.markBuilt(el, fx, cur.def);
      this.done++;
      this.hooks.onProgress(this.done, this.total);
      return;
    }
    const mode = t.mode ?? "drag";
    const x0 = clamp(r.left, 4, vw - 4),
      y0 = clamp(r.top, 4, vh - 4),
      x1 = clamp(r.right, 4, vw - 4),
      y1 = clamp(r.bottom, 4, vh - 4);
    if (mode === "carry") {
      // The cursor travels the same route without transforming page content.
      const side = Math.random() < 0.5 ? -1 : 1;
      const sx = clamp(x0 + (x1 - x0) / 2 + side * rand(300, 700), -40, vw + 40);
      const sy = vh + rand(40, 120);
      await cur.moveTo(sx, sy, 230, ease.out);
      const cx = (x0 + x1) / 2,
        cy = (y0 + y1) / 2;
      const dur = clamp(Math.hypot(cx - sx, cy - sy) * 0.55, 520, 900);
      await cur.moveTo(cx, cy, dur, ease.outExpo);
      this.markBuilt(el, "none", cur.def);
      this.tick(cur.def, t.log);
      await this.sleep(t.hold ?? 80);
      return;
    }

    if (mode === "click") {
      await cur.moveTo((x0 + x1) / 2 + rand(-4, 4), (y0 + y1) / 2 + rand(-3, 3), undefined, ease.inOut);
      cur.el.classList.add("down");
      await this.sleep(70);
      this.markBuilt(el, fx ?? "pop", cur.def);
      cur.el.classList.remove("down");
      this.tick(cur.def, t.log);
      await this.sleep(t.hold ?? 90);
      return;
    }

    // drag / type
    await cur.moveTo(x0, y0);
    cur.el.classList.add("down");
    await this.sleep(60);
    const dur = mode === "type" ? 380 : clamp(Math.hypot(x1 - x0, y1 - y0) * 0.55, 260, 520);
    const ep = cur.epoch;
    await this.tween(dur, ease.out, (k) => {
      const px = x0 + (x1 - x0) * k,
        py = y0 + (y1 - y0) * k;
      cur.set(px, py);
    }, () => cur.epoch === ep);
    cur.el.classList.remove("down");
    this.markBuilt(el, fx, cur.def);
    this.tick(cur.def, t.log);
    if (mode === "type") {
      // cursor rides the text as it appears
      const ty = (y0 + y1) / 2;
      const dd = clamp((x1 - x0) * 0.9, 380, 900);
      el.style.setProperty("--ld", `${Math.round(dd / Math.max(1, (el.dataset.chars ? +el.dataset.chars : 8)))}ms`);
      cur.set(x0, ty);
      await this.tween(dd, ease.out, (k) => cur.set(x0 + (x1 - x0) * k, ty + Math.sin(k * 7) * 6), () => cur.epoch === ep);
    } else {
      await this.sleep(t.hold ?? 60);
    }
  }

  // ---------------------------------------------------------------- run
  async run(plan: Plan) {
    this.t0 = performance.now();
    this.total = Object.values(plan).reduce((n, p) => n + p.tasks.length, 0);
    const vw = window.innerWidth,
      vh = window.innerHeight;
    const jobs = AGENTS.map(async (a, i) => {
      const cur = this.cursors[a.id];
      const p = plan[a.id];
      // spawn off-canvas at an edge
      const edge = i % 4;
      const sx = edge === 0 ? -60 : edge === 1 ? vw + 60 : rand(0, vw);
      const sy = edge === 2 ? -60 : edge === 3 ? vh + 60 : rand(0, vh);
      cur.set(sx, sy);
      cur.el.classList.add("visible");
      if (!p) return;
      await this.sleep(p.delay);
      for (const t of p.tasks) {
        if (this.dead) return;
        await this.doBuild(cur, t);
      }
    });
    await Promise.all(jobs);
    if (this.dead) return;
    this.skipped = false;
    // everything leftover (safety)
    document.querySelectorAll<HTMLElement>("[data-build]:not(.built)").forEach((el) => el.classList.add("built"));
    this.hooks.onDone(performance.now() - this.t0);
    this.ambient();
  }

  // ---------------------------------------------------------------- ambient life
  setAmbient(on: boolean) {
    this.ambientOn = on;
    this.layer.classList.toggle("off", !on);
  }

  gather(el: HTMLElement | null) {
    this.gatherEl = el;
    Object.values(this.cursors).forEach((c) => c.interrupt());
  }

  private async ambient() {
    // gather to the middle first, then disperse to their own life
    await this.sleep(this.skipped ? 0 : 600);
    AGENTS.forEach((a, i) => this.life(this.cursors[a.id], i));
  }

  private async life(cur: Cursor, idx: number) {
    await new Promise((r) => setTimeout(r, 400 + idx * 650));
    let angle = (idx / AGENTS.length) * Math.PI * 2 - Math.PI / 2;
    let travelled = 0;
    const lap = Math.PI * 2;
    while (!this.dead && travelled < lap) {
      if (!this.ambientOn) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      if (this.gatherEl) {
        const r = this.gatherEl.getBoundingClientRect();
        const ang = (idx / AGENTS.length) * Math.PI * 2 - Math.PI / 2;
        const gx = r.left + r.width / 2 + Math.cos(ang) * (r.width * 0.5 + 40 + (idx % 2) * 30);
        const gy = r.top + r.height / 2 + Math.sin(ang) * (r.height * 0.5 + 40 + (idx % 2) * 24);
        await cur.moveTo(gx, gy, 700 + idx * 60, ease.outExpo);
        while (this.gatherEl && !this.dead) {
          // restless jitter around the target
          await cur.moveTo(gx + rand(-14, 14), gy + rand(-14, 14), 380, ease.inOut);
        }
        continue;
      }
      const orb = document.querySelector<HTMLElement>('[data-build="orb"]');
      if (!orb) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const r = orb.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = Math.max(22, Math.min(42, r.height * 0.28));
      const radiusX = Math.min(r.width * 0.42 + gap, vw * 0.42);
      const radiusY = Math.min(r.height * 0.6 + gap, vh * 0.18);
      const x = clamp(r.left + r.width / 2 + Math.cos(angle) * radiusX, 18, vw - 18);
      const y = clamp(r.top + r.height / 2 + Math.sin(angle) * radiusY, 72, vh - 52);
      const step = 0.55 + idx * 0.025;
      const moved = await cur.moveTo(x, y, 560 + idx * 35, ease.outExpo);
      if (moved) {
        angle += step;
        travelled += step;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.dead) return;
    while ((!this.ambientOn || this.gatherEl) && !this.dead) await new Promise((r) => setTimeout(r, 300));
    if (this.dead) return;
    const orb = document.querySelector<HTMLElement>('[data-build="orb"]');
    if (!orb) return;
    const r = orb.getBoundingClientRect();
    await cur.moveTo(r.left + r.width / 2, r.top + r.height / 2, 720 + idx * 45, ease.inOut);
    cur.el.classList.add("absorbing");
  }
}
