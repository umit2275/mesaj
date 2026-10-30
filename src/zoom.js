/**
 * Büyük fotoğrafta yakınlaştırma:
 *  - iki parmakla açıp kapatma (1x–5x)
 *  - çift dokunuş: 2,5x yakınlaş / geri dön
 *  - yakınken tek parmakla kaydırma
 */
export function enableZoom(img, box) {
  let scale = 1, tx = 0, ty = 0;
  const pts = new Map();
  let pinch = null; // { dist, scale, mx, my, tx, ty }
  let pan = null; // { x, y, tx, ty }
  let lastTap = { t: 0, x: 0, y: 0 };
  let moved = false;
  let lastToggle = 0;

  img.style.touchAction = 'none';
  img.style.transformOrigin = 'center center';
  img.draggable = false;

  const clamp = () => {
    scale = Math.min(5, Math.max(1, scale));
    if (scale <= 1.001) {
      scale = 1; tx = 0; ty = 0;
      return;
    }
    const maxX = Math.max(0, (img.offsetWidth * scale - box.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * scale - box.clientHeight) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  };
  const apply = (animate = false) => {
    img.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.dataset.scale = String(scale);
  };
  /** Ekrandaki (x, y) noktası yerinde kalacak şekilde ölçeği değiştir */
  const zoomAt = (newScale, x, y, animate) => {
    const r = img.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const k = newScale / scale;
    tx += (x - cx) * (1 - k);
    ty += (y - cy) * (1 - k);
    scale = newScale;
    clamp();
    apply(animate);
  };
  const toggleAt = (x, y) => (scale > 1 ? (scale = 1, clamp(), apply(true)) : zoomAt(2.5, x, y, true));

  img.addEventListener('pointerdown', (e) => {
    img.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx, ty };
      pan = null;
    } else if (pts.size === 1) {
      pan = { x: e.clientX, y: e.clientY, tx, ty };
    }
  });
  img.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const target = Math.min(5, Math.max(1, (pinch.scale * d) / pinch.dist));
      // başlangıç durumuna dön, sonra orta noktaya göre ölçekle + kaydır
      scale = pinch.scale; tx = pinch.tx; ty = pinch.ty;
      zoomAt(target, pinch.mx, pinch.my, false);
      tx += mx - pinch.mx; ty += my - pinch.my;
      clamp();
      apply();
      moved = true;
    } else if (pan && scale > 1) {
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (Math.hypot(dx, dy) > 4) moved = true;
      tx = pan.tx + dx; ty = pan.ty + dy;
      clamp();
      apply();
    } else if (pan && Math.hypot(e.clientX - pan.x, e.clientY - pan.y) > 8) {
      moved = true;
    }
  });
  const end = (e) => {
    const wasSingle = pts.size === 1 && !pinch;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) {
      const [p] = [...pts.values()];
      pan = { x: p.x, y: p.y, tx, ty };
    } else if (!pts.size) pan = null;
    if (e.type === 'pointerup' && wasSingle && !moved) {
      const now = Date.now();
      if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        toggleAt(e.clientX, e.clientY);
        lastToggle = now;
        lastTap = { t: 0, x: 0, y: 0 };
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  };
  img.addEventListener('pointerup', end);
  img.addEventListener('pointercancel', end);
  // Bilgisayarda: çift tık ve fare tekerleği
  img.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (Date.now() - lastToggle < 700) return; // çift dokunuş zaten işlendi
    toggleAt(e.clientX, e.clientY);
  });
  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(Math.min(5, Math.max(1, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))), e.clientX, e.clientY, false);
  }, { passive: false });
  return { get scale() { return scale; }, reset: () => { scale = 1; clamp(); apply(true); } };
}
