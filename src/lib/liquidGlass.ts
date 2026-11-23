import { useEffect } from 'react';

/**
 * Жидкое стекло как в твоём референсе: SVG-фильтр с картой смещения (feImage + feDisplacementMap),
 * только карта строится автоматически под размер и скругление каждого элемента.
 * Подхватывает все элементы с классами .glass, .glass-raised, .btn-primary.
 * При нажатии на любую кнопку стекло «плещется» (волна в рефракции + желейное сжатие).
 * Работает в Chromium (Chrome, Edge, Opera, Яндекс). В остальных браузерах остаётся запасной блюр из CSS.
 */

const SEL = '.glass, .glass-raised, .btn-primary';
const BASE_SCALE = 48; // сила рефракции из референса
const BACKDROP = 'blur(0.6px) brightness(1.4) saturate(1.4)';
const SVGNS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

interface Lens {
  el: HTMLElement;
  filter: SVGFilterElement;
  map: SVGFEImageElement;
  disp: SVGFEDisplacementMapElement;
  w: number;
  h: number;
  r: number;
  raf: number;
  timer: number;
}

// Карта смещения: в центре нейтральная (128,128), к краям — смещение внутрь (эффект выпуклой линзы)
function makeMap(w: number, h: number, radius: number): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const r = Math.min(radius, w / 2, h / 2);
  const bezel = Math.max(10, Math.min(Math.min(w, h) * 0.32, 38));
  const hx = w / 2;
  const hy = h / 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hx;
      const py = y + 0.5 - hy;
      const qx = Math.abs(px) - (hx - r);
      const qy = Math.abs(py) - (hy - r);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const len = Math.hypot(ox, oy);
      const dist = -(len + Math.min(Math.max(qx, qy), 0) - r); // расстояние до края внутрь
      let nx = 0;
      let ny = 0;
      if (len > 0) {
        nx = (ox / len) * Math.sign(px);
        ny = (oy / len) * Math.sign(py);
      } else if (qx > qy) nx = Math.sign(px);
      else ny = Math.sign(py);

      const t = Math.min(Math.max(dist / bezel, 0), 1);
      const m = (1 - t) * (1 - t);
      const i = (y * w + x) * 4;
      d[i] = 128 - 127 * m * nx;
      d[i + 1] = 128 - 127 * m * ny;
      d[i + 2] = 0;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

export function useLiquidGlass() {
  useEffect(() => {
    if (!document.documentElement.classList.contains('can-refract')) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none';
    const defs = document.createElementNS(SVGNS, 'defs');
    svg.appendChild(defs);
    document.body.appendChild(svg);

    const lenses = new Map<Element, Lens>();
    let counter = 0;

    const update = (L: Lens) => {
      const w = L.el.offsetWidth;
      const h = L.el.offsetHeight;
      const r = parseFloat(getComputedStyle(L.el).borderTopLeftRadius) || 0;
      if (!w || !h || (w === L.w && h === L.h && r === L.r)) return;
      L.w = w;
      L.h = h;
      L.r = r;
      const url = makeMap(w, h, r);
      L.filter.setAttribute('width', String(w));
      L.filter.setAttribute('height', String(h));
      L.map.setAttribute('width', String(w));
      L.map.setAttribute('height', String(h));
      L.map.setAttribute('href', url);
      L.map.setAttributeNS(XLINK, 'xlink:href', url);
    };

    // пока плашка тянется, карту линзы перестраиваем не чаще раза в 80 мс (последнее обновление всегда выполняется)
    const schedule = (L: Lens) => {
      if (L.timer) return;
      L.timer = window.setTimeout(() => {
        L.timer = 0;
        update(L);
      }, 80);
    };
    const ro = new ResizeObserver(entries => {
      entries.forEach(e => {
        const L = lenses.get(e.target);
        if (L) schedule(L);
      });
    });

    const addLens = (el: HTMLElement) => {
      const id = `lg-${++counter}`;
      const filter = document.createElementNS(SVGNS, 'filter');
      filter.setAttribute('id', id);
      filter.setAttribute('filterUnits', 'userSpaceOnUse');
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      filter.setAttribute('x', '0');
      filter.setAttribute('y', '0');
      const map = document.createElementNS(SVGNS, 'feImage') as SVGFEImageElement;
      map.setAttribute('preserveAspectRatio', 'none');
      map.setAttribute('result', 'map');
      const disp = document.createElementNS(SVGNS, 'feDisplacementMap') as SVGFEDisplacementMapElement;
      disp.setAttribute('in', 'SourceGraphic');
      disp.setAttribute('in2', 'map');
      disp.setAttribute('xChannelSelector', 'R');
      disp.setAttribute('yChannelSelector', 'G');
      disp.setAttribute('scale', String(BASE_SCALE));
      filter.append(map, disp);
      defs.appendChild(filter);

      const L: Lens = { el, filter, map, disp, w: 0, h: 0, r: -1, raf: 0, timer: 0 };
      lenses.set(el, L);
      const value = `url(#${id}) ${BACKDROP}`;
      el.style.setProperty('backdrop-filter', value);
      el.style.setProperty('-webkit-backdrop-filter', value);
      update(L);
      ro.observe(el);
    };

    const scan = () => {
      document.querySelectorAll<HTMLElement>(SEL).forEach(el => {
        if (!lenses.has(el)) addLens(el);
      });
      lenses.forEach((L, el) => {
        if (!el.isConnected) {
          cancelAnimationFrame(L.raf);
          clearTimeout(L.timer);
          ro.unobserve(el);
          L.filter.remove();
          lenses.delete(el);
        }
      });
    };

    let scheduled = 0;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(scan);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    scan();

    // --- ПЛЕСК ПРИ НАЖАТИИ ---
    const splash = (btn: HTMLElement) => {
      if (reduceMotion) return;
      const targets = new Set<Lens>();
      const pick = (e: Element | null) => {
        const L = e ? lenses.get(e) : undefined;
        if (L) targets.add(L);
      };
      pick(btn.closest(SEL));
      btn.querySelectorAll(SEL).forEach(pick);
      // группа (таб-бар): булькает и сама панель, и плашка, которая в ней бегает
      const group = btn.closest('[data-liquid-group]');
      if (group) {
        pick(group);
        group.querySelectorAll(SEL).forEach(pick);
      }

      // желейное сжатие (composite: 'add' — не ломает transform от framer-motion)
      btn.animate(
        [
          { transform: 'scale(1, 1)' },
          { transform: 'scale(1.09, 0.88)', offset: 0.14 },
          { transform: 'scale(0.95, 1.07)', offset: 0.34 },
          { transform: 'scale(1.03, 0.98)', offset: 0.55 },
          { transform: 'scale(0.99, 1.01)', offset: 0.78 },
          { transform: 'scale(1, 1)' },
        ],
        { duration: 800, easing: 'cubic-bezier(.2,.7,.3,1)', composite: 'add' }
      );

      // волна в самой рефракции: сила то растёт, то уходит в минус — стекло «колышется»
      targets.forEach(L => {
        cancelAnimationFrame(L.raf);
        const t0 = performance.now();
        const tick = (now: number) => {
          const t = (now - t0) / 1000;
          const s = BASE_SCALE + 75 * Math.exp(-3.4 * t) * Math.cos(t * Math.PI * 2 * 2.4);
          L.disp.setAttribute('scale', String(s));
          if (t < 1.5) L.raf = requestAnimationFrame(tick);
          else L.disp.setAttribute('scale', String(BASE_SCALE));
        };
        L.raf = requestAnimationFrame(tick);
      });
    };

    const onDown = (e: PointerEvent) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('button');
      if (b && !b.disabled) splash(b);
    };
    document.addEventListener('pointerdown', onDown);

    return () => {
      document.removeEventListener('pointerdown', onDown);
      mo.disconnect();
      ro.disconnect();
      lenses.forEach(L => {
        cancelAnimationFrame(L.raf);
        clearTimeout(L.timer);
        L.el.style.removeProperty('backdrop-filter');
        L.el.style.removeProperty('-webkit-backdrop-filter');
      });
      svg.remove();
    };
  }, []);
}
