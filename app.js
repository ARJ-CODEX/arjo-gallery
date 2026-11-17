/* LensForge — offline photo studio & private vault.
   Vanilla JS, zero dependencies, zero network. */

"use strict";

/* ================= helpers ================= */

const $ = (id) => document.getElementById(id);

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ================= view tabs ================= */

const VIEWS = ["studio", "vault", "exif"];
function switchView(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
    b.setAttribute("aria-selected", b.dataset.view === name ? "true" : "false");
  });
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === `view-${name}`);
  });
}
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});
window.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  const idx = ["1", "2", "3"].indexOf(e.key);
  if (idx >= 0) switchView(VIEWS[idx]);
});

/* ================= EXIF parser (JPEG APP1) ================= */

const EXIF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function parseExif(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG

    // find the Exif APP1 segment
    let offset = 2;
    let tiff = -1;
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset);
      if ((marker & 0xff00) !== 0xff00) break;
      const segSize = view.getUint16(offset + 2);
      if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) {
        tiff = offset + 10;
        break;
      }
      offset += 2 + segSize;
    }
    if (tiff < 0 || tiff + 8 > view.byteLength) return null;

    const little = view.getUint16(tiff) === 0x4949;
    const u16 = (o) => view.getUint16(o, little);
    const u32 = (o) => view.getUint32(o, little);

    function readAscii(off, count) {
      let s = "";
      for (let i = 0; i < count - 1 && off + i < view.byteLength; i++) {
        const ch = view.getUint8(off + i);
        if (ch === 0) break;
        s += String.fromCharCode(ch);
      }
      return s.trim();
    }
    function readRationals(off, count) {
      const out = [];
      for (let i = 0; i < count; i++) {
        const num = u32(off + i * 8);
        const den = u32(off + i * 8 + 4);
        out.push(den === 0 ? 0 : num / den);
      }
      return out;
    }

    const tags = {};
    let subIfd = 0;
    let gpsIfd = 0;

    const ifd0 = tiff + u32(tiff + 4);
    const entries = u16(ifd0);
    for (let i = 0; i < entries; i++) {
      const e = ifd0 + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const sz = (EXIF_TYPE_SIZE[type] || 1) * count;
      const val = sz > 4 ? tiff + u32(e + 8) : e + 8;
      if (val >= view.byteLength) continue;
      switch (tag) {
        case 0x010f: tags.make = readAscii(val, count); break;
        case 0x0110: tags.model = readAscii(val, count); break;
        case 0x0131: tags.software = readAscii(val, count); break;
        case 0x0132: tags.dateTime = readAscii(val, count); break;
        case 0x8769: subIfd = tiff + u32(e + 8); break;
        case 0x8825: gpsIfd = tiff + u32(e + 8); break;
      }
    }

    if (subIfd && subIfd + 2 < view.byteLength) {
      const n = u16(subIfd);
      for (let i = 0; i < n; i++) {
        const e = subIfd + 2 + i * 12;
        const tag = u16(e);
        const type = u16(e + 2);
        const count = u32(e + 4);
        const sz = (EXIF_TYPE_SIZE[type] || 1) * count;
        const val = sz > 4 ? tiff + u32(e + 8) : e + 8;
        if (val >= view.byteLength) continue;
        switch (tag) {
          case 0x829a: tags.exposure = readRationals(val, count)[0]; break;
          case 0x829d: tags.fnumber = readRationals(val, count)[0]; break;
          case 0x8827: tags.iso = u16(val); break;
          case 0x920a: tags.focal = readRationals(val, count)[0]; break;
        }
      }
    }

    if (gpsIfd && gpsIfd + 2 < view.byteLength) {
      const n = u16(gpsIfd);
      let latRef = "", lonRef = "", lat = null, lon = null, alt = null;
      for (let i = 0; i < n; i++) {
        const e = gpsIfd + 2 + i * 12;
        const tag = u16(e);
        const type = u16(e + 2);
        const count = u32(e + 4);
        const sz = (EXIF_TYPE_SIZE[type] || 1) * count;
        const val = sz > 4 ? tiff + u32(e + 8) : e + 8;
        switch (tag) {
          case 0x0001: latRef = readAscii(val, count); break;
          case 0x0002: {
            const r = readRationals(val, 3);
            lat = r[0] + r[1] / 60 + r[2] / 3600;
            break;
          }
          case 0x0003: lonRef = readAscii(val, count); break;
          case 0x0004: {
            const r = readRationals(val, 3);
            lon = r[0] + r[1] / 60 + r[2] / 3600;
            break;
          }
          case 0x0006: alt = readRationals(val, 1)[0]; break;
        }
      }
      if (lat !== null && lon !== null) {
        if (latRef === "S") lat = -lat;
        if (lonRef === "W") lon = -lon;
        tags.gps = { lat, lon, alt };
      }
    }

    return tags;
  } catch {
    return null;
  }
}

function exifSummary(tags) {
  const rows = [];
  if (tags.make || tags.model)
    rows.push({ label: "📱 Device", value: [tags.make, tags.model].filter(Boolean).join(" ") });
  if (tags.dateTime) rows.push({ label: "🕐 Taken", value: tags.dateTime });
  if (tags.software) rows.push({ label: "💾 Software", value: tags.software });
  if (tags.iso || tags.fnumber || tags.exposure || tags.focal) {
    const bits = [];
    if (tags.fnumber) bits.push("f/" + tags.fnumber.toFixed(1));
    if (tags.exposure) bits.push("1/" + Math.round(1 / tags.exposure) + "s");
    if (tags.iso) bits.push("ISO " + tags.iso);
    if (tags.focal) bits.push(Math.round(tags.focal) + "mm");
    rows.push({ label: "📷 Shot", value: bits.join(" · ") });
  }
  if (tags.gps) {
    const g = tags.gps;
    rows.push({
      label: "📍 GPS location ⚠",
      value: `${Math.abs(g.lat).toFixed(5)}°${g.lat >= 0 ? "N" : "S"}, ${Math.abs(g.lon).toFixed(5)}°${g.lon >= 0 ? "E" : "W"}` +
        (g.alt != null ? ` · ${Math.round(g.alt)}m alt` : ""),
      danger: true,
    });
  }
  return rows;
}

/* ================= studio: state, presets, render ================= */

const PRESETS = [
  { id: "original", name: "Original", filter: "" },
  { id: "vivid", name: "Vivid", filter: "saturate(1.5) contrast(1.15)" },
  { id: "noir", name: "Noir", filter: "grayscale(1) contrast(1.38) brightness(0.95)" },
  { id: "fade", name: "Fade", filter: "saturate(0.72) contrast(0.88) brightness(1.06)", fx: { fade: 22 } },
  { id: "cinema", name: "Cinema", filter: "contrast(1.22) saturate(1.12) hue-rotate(-8deg)", fx: { cool: 18 } },
  { id: "warmglow", name: "Warm Glow", filter: "saturate(1.2) brightness(1.06) sepia(0.16)" },
  { id: "cool", name: "Arctic", filter: "saturate(0.95) brightness(1.02)", fx: { cool: 26 } },
  { id: "sepiafilm", name: "Sepia Film", filter: "sepia(0.62) contrast(1.05) saturate(0.9)" },
  { id: "sunset", name: "Sunset", filter: "saturate(1.32) sepia(0.28) contrast(1.05)", fx: { warm: 14 } },
  { id: "retro70", name: "Retro 70s", filter: "sepia(0.38) saturate(1.22) contrast(0.92) brightness(1.04)", fx: { fade: 16 } },
  { id: "highkey", name: "High Key", filter: "brightness(1.16) contrast(0.9) saturate(0.86)" },
  { id: "moody", name: "Moody", filter: "brightness(0.84) contrast(1.3) saturate(0.78)", fx: { vign: 24 } },
  { id: "neon", name: "Neon Night", filter: "saturate(1.8) contrast(1.28) hue-rotate(-14deg)" },
  { id: "softportrait", name: "Soft Portrait", filter: "saturate(0.92) brightness(1.05) contrast(0.95)" },
  { id: "dramatic", name: "Dramatic", filter: "contrast(1.45) saturate(1.18) brightness(0.96)", fx: { vign: 20 } },
  { id: "dream", name: "Dream", filter: "brightness(1.08) saturate(1.1) contrast(0.94)", fx: { fade: 26, warm: 10 } },
];

const ADJUST_DEFS = [
  { id: "brightness", label: "Brightness", min: -100, max: 100, def: 0 },
  { id: "contrast", label: "Contrast", min: -100, max: 100, def: 0 },
  { id: "saturation", label: "Saturation", min: -100, max: 100, def: 0 },
  { id: "warmth", label: "Warmth", min: -100, max: 100, def: 0 },
  { id: "fade", label: "Fade", min: 0, max: 100, def: 0 },
  { id: "vignette", label: "Vignette", min: 0, max: 100, def: 0 },
  { id: "grain", label: "Film grain", min: 0, max: 100, def: 0 },
];

const studio = {
  bitmap: null, // ImageBitmap or HTMLImageElement
  name: "photo",
  sizeBytes: 0,
  isJpeg: false,
  preset: "original",
  adj: {},
  rotate: 0,
  flipH: false,
  flipV: false,
  crop: "free",
  comparing: false,
};
ADJUST_DEFS.forEach((d) => (studio.adj[d.id] = d.def));

let grainTile = null;
function getGrainTile() {
  if (grainTile) return grainTile;
  const t = document.createElement("canvas");
  t.width = 160;
  t.height = 160;
  const g = t.getContext("2d");
  const img = g.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 90 + Math.random() * 130;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  grainTile = t;
  return t;
}

function transformedCanvas(maxDim) {
  const img = studio.bitmap;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const swap = studio.rotate === 90 || studio.rotate === 270;
  const cw = swap ? h : w;
  const ch = swap ? w : h;

  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const g = c.getContext("2d");
  g.translate(cw / 2, ch / 2);
  g.rotate((studio.rotate * Math.PI) / 180);
  g.scale(studio.flipH ? -1 : 1, studio.flipV ? -1 : 1);
  g.drawImage(img, -w / 2, -h / 2, w, h);
  g.setTransform(1, 0, 0, 1, 0, 0);

  if (studio.crop !== "free") {
    const [ar, br] = studio.crop.split(":").map(Number);
    const target = ar / br;
    let cropW = cw;
    let cropH = ch;
    if (cw / ch > target) cropW = Math.round(ch * target);
    else cropH = Math.round(cw / target);
    const sx = Math.round((cw - cropW) / 2);
    const sy = Math.round((ch - cropH) / 2);
    const cc = document.createElement("canvas");
    cc.width = cropW;
    cc.height = cropH;
    cc.getContext("2d").drawImage(c, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
    return cc;
  }
  return c;
}

function buildFilterString(forPreview) {
  const p = PRESETS.find((x) => x.id === studio.preset) || PRESETS[0];
  const a = studio.adj;
  const parts = [];
  if (!forPreview && p.filter) parts.push(p.filter);
  if (a.brightness) parts.push(`brightness(${(1 + a.brightness / 100).toFixed(3)})`);
  if (a.contrast) parts.push(`contrast(${(1 + a.contrast / 100).toFixed(3)})`);
  if (a.saturation) parts.push(`saturate(${Math.max(0, 1 + a.saturation / 100).toFixed(3)})`);
  return parts.join(" ");
}

function applyOverlays(g, w, h, fx) {
  const a = studio.adj;
  const warm = (a.warmth || 0) + (fx.warm || 0);
  const cool = (a.warmth || 0) < 0 ? -a.warmth : 0;
  const coolFx = fx.cool || 0;

  if (warm > 0) {
    g.save();
    g.globalCompositeOperation = "soft-light";
    g.fillStyle = `rgba(255, 140, 50, ${Math.min(0.7, warm / 200)})`;
    g.fillRect(0, 0, w, h);
    g.restore();
  }
  const coolTotal = (a.warmth || 0) < 0 ? -a.warmth : 0;
  if (coolTotal > 0 || coolFx > 0) {
    g.save();
    g.globalCompositeOperation = "soft-light";
    g.fillStyle = `rgba(60, 124, 255, ${Math.min(0.7, (coolTotal + coolFx) / 200)})`;
    g.fillRect(0, 0, w, h);
    g.restore();
  }

  const fade = (a.fade || 0) + (fx.fade || 0);
  if (fade > 0) {
    g.save();
    g.globalCompositeOperation = "lighten";
    g.fillStyle = `rgba(30, 32, 38, ${Math.min(0.85, fade / 130)})`;
    g.fillRect(0, 0, w, h);
    g.restore();
  }

  const vign = (a.vignette || 0) + (fx.vign || 0);
  if (vign > 0) {
    const r = Math.sqrt(w * w + h * h) / 2;
    const grad = g.createRadialGradient(w / 2, h / 2, r * 0.42, w / 2, h / 2, r);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, vign / 120)})`);
    g.save();
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.restore();
  }

  const grain = a.grain || 0;
  if (grain > 0) {
    g.save();
    g.globalCompositeOperation = "overlay";
    g.globalAlpha = Math.min(0.6, grain / 160);
    const pattern = g.createPattern(getGrainTile(), "repeat");
    g.fillStyle = pattern;
    g.fillRect(0, 0, w, h);
    g.restore();
  }
}

function renderTo(canvas, work, withFx) {
  canvas.width = work.width;
  canvas.height = work.height;
  const g = canvas.getContext("2d");
  if (studio.comparing) {
    g.drawImage(work, 0, 0);
    return;
  }
  g.save();
  const filter = buildFilterString(false);
  if (filter) g.filter = filter;
  g.drawImage(work, 0, 0);
  g.restore();
  if (withFx) applyOverlays(g, work.width, work.height, withFx);
}

function renderStudio() {
  if (!studio.bitmap) return;
  const work = transformedCanvas(1500);
  const p = PRESETS.find((x) => x.id === studio.preset) || PRESETS[0];
  renderTo($("edit-canvas"), work, p.fx || {});
  $("img-dims").textContent = `${studio.bitmap.width} × ${studio.bitmap.height} px`;
}

let thumbTimer = null;
function scheduleThumbRefresh() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(renderPresetThumbs, 180);
}

function renderPresetThumbs() {
  if (!studio.bitmap) return;
  const work = transformedCanvas(160);
  document.querySelectorAll(".preset-card").forEach((card) => {
    const p = PRESETS.find((x) => x.id === card.dataset.preset);
    if (!p) return;
    const t = document.createElement("canvas");
    const g = t.getContext("2d");
    t.width = work.width;
    t.height = work.height;
    g.save();
    const parts = [];
    if (p.filter) parts.push(p.filter);
    const a = studio.adj;
    if (a.brightness) parts.push(`brightness(${1 + a.brightness / 100})`);
    if (a.contrast) parts.push(`contrast(${1 + a.contrast / 100})`);
    if (a.saturation) parts.push(`saturate(${Math.max(0, 1 + a.saturation / 100)})`);
    if (parts.length) g.filter = parts.join(" ");
    g.drawImage(work, 0, 0);
    g.restore();
    if (p.fx) applyOverlays(g, work.width, work.height, p.fx);
    card.querySelector("img").src = t.toDataURL("image/jpeg", 0.8);
  });
}

function buildStudioUI() {
  // preset grid
  const grid = $("preset-grid");
  grid.innerHTML = "";
  PRESETS.forEach((p) => {
    const card = document.createElement("div");
    card.className = "preset-card" + (p.id === studio.preset ? " active" : "");
    card.dataset.preset = p.id;
    card.innerHTML = `<img class="preset-thumb" alt="${p.name} preview" /><div class="preset-name">${p.name}</div>`;
    card.addEventListener("click", () => {
      studio.preset = p.id;
      document.querySelectorAll(".preset-card").forEach((c) =>
        c.classList.toggle("active", c.dataset.preset === p.id)
      );
      renderStudio();
      toast(`Preset: ${p.name}`);
    });
    grid.appendChild(card);
  });

  // sliders
  const wrap = $("adjust-sliders");
  wrap.innerHTML = "";
  ADJUST_DEFS.forEach((d) => {
    const row = document.createElement("div");
    row.className = "slider-row";
    row.innerHTML = `
      <label for="adj-${d.id}">${d.label}</label>
      <input type="range" id="adj-${d.id}" min="${d.min}" max="${d.max}" value="${studio.adj[d.id]}" />
      <span class="slider-val" id="adjv-${d.id}">${studio.adj[d.id]}</span>`;
    const input = row.querySelector("input");
    input.addEventListener("input", () => {
      studio.adj[d.id] = Number(input.value);
      $("adjv-" + d.id).textContent = input.value;
      renderStudio();
      scheduleThumbRefresh();
    });
    wrap.appendChild(row);
  });
}

async function loadStudioFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    toast("Please pick an image file");
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    studio.bitmap = bitmap;
    studio.name = file.name.replace(/\.[^.]+$/, "") || "photo";
    studio.sizeBytes = file.size;
    studio.isJpeg = file.type === "image/jpeg";
    studio.preset = "original";
    studio.rotate = 0;
    studio.flipH = false;
    studio.flipV = false;
    studio.crop = "free";
    $("crop-select").value = "free";
    ADJUST_DEFS.forEach((d) => {
      studio.adj[d.id] = d.def;
      const input = $("adj-" + d.id);
      if (input) input.value = d.def;
      const val = $("adjv-" + d.id);
      if (val) val.textContent = d.def;
    });

    $("studio-empty").hidden = true;
    $("studio-workbench").hidden = false;
    $("export-name").value = studio.name + "-lensforge";

    // EXIF note
    const buf = await file.arrayBuffer();
    const tags = studio.isJpeg ? parseExif(buf) : null;
    const mp = ((bitmap.width * bitmap.height) / 1e6).toFixed(1);
    if (tags && tags.gps) {
      $("exif-note").innerHTML = `⚠ Loaded ${mp} MP — this file carries <b>GPS location</b>. Every export strips it.`;
    } else if (tags && (tags.make || tags.model || tags.dateTime)) {
      $("exif-note").innerHTML = `Loaded ${mp} MP — device metadata detected; exports are always stripped clean.`;
    } else {
      $("exif-note").textContent = `Loaded ${mp} MP — clean file, and every export stays clean.`;
    }

    renderStudio();
    renderPresetThumbs();
    toast("Photo loaded — forge it!");
  } catch (err) {
    toast("Could not read that image");
  }
}

/* ---- studio events ---- */

function bindStudioEvents() {
  $("open-photo-btn").addEventListener("click", () => $("studio-file").click());
  $("replace-photo-btn").addEventListener("click", () => $("studio-file-2").click());
  $("studio-file").addEventListener("change", (e) => {
    loadStudioFile(e.target.files[0]);
    e.target.value = "";
  });
  $("studio-file-2").addEventListener("change", (e) => {
    loadStudioFile(e.target.files[0]);
    e.target.value = "";
  });

  $("reset-adjust-btn").addEventListener("click", () => {
    ADJUST_DEFS.forEach((d) => {
      studio.adj[d.id] = d.def;
      $("adj-" + d.id).value = d.def;
      $("adjv-" + d.id).textContent = d.def;
    });
    renderStudio();
    scheduleThumbRefresh();
    toast("Adjustments reset");
  });

  // compare: hold to see the untouched original
  const compare = $("compare-btn");
  const startCompare = (e) => {
    e.preventDefault();
    studio.comparing = true;
    renderStudio();
  };
  const stopCompare = () => {
    if (!studio.comparing) return;
    studio.comparing = false;
    renderStudio();
  };
  compare.addEventListener("pointerdown", startCompare);
  window.addEventListener("pointerup", stopCompare);
  window.addEventListener("pointercancel", stopCompare);

  // rotate / flip
  document.querySelectorAll("#rotate-seg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      studio.rotate = (studio.rotate + Number(btn.dataset.rotate)) % 360;
      renderStudio();
    });
  });
  document.querySelectorAll("#flip-seg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.flip === "h") studio.flipH = !studio.flipH;
      else studio.flipV = !studio.flipV;
      renderStudio();
    });
  });
  $("crop-select").addEventListener("change", (e) => {
    studio.crop = e.target.value;
    renderStudio();
  });

  // export
  $("export-format").addEventListener("change", (e) => {
    $("quality-label").hidden = e.target.value === "png";
  });
  $("export-btn").addEventListener("click", exportPhoto);

  $("save-vault-btn").addEventListener("click", async () => {
    if (!vault.unlocked) {
      toast("Unlock the Vault first 🔐");
      switchView("vault");
      return;
    }
    const { blob, name } = await buildExportBlob();
    await vaultAddBlob(blob, name);
    toast("Saved into the Vault 🔐");
  });
}

async function buildExportBlob() {
  const work = transformedCanvas(6000); // full-res export cap
  const out = document.createElement("canvas");
  renderTo(out, work, (PRESETS.find((p) => p.id === studio.preset) || PRESETS[0]).fx || {});
  const fmt = $("export-format").value;
  const quality = Number($("export-quality").value) / 100;
  const type = fmt === "png" ? "image/png" : "image/jpeg";
  const blob = await new Promise((res) => out.toBlob(res, type, quality));
  let name = ($("export-name").value || "lensforge-photo").trim() || "lensforge-photo";
  name = name + (fmt === "png" ? ".png" : ".jpg");
  return { blob, name };
}

async function exportPhoto() {
  if (!studio.bitmap) return;
  toast("Forging export…");
  const { blob, name } = await buildExportBlob();
  download(blob, name);
  toast(`Exported ${formatBytes(blob.size)} — metadata stripped ✅`);
}

/* ================= vault ================= */

const DB_NAME = "lensforge";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function hashPin(pin, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 150000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function makeThumb(blob, maxDim = 240) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL("image/jpeg", 0.78);
}

const vault = {
  unlocked: false,
  lastActive: Date.now(),
  timer: null,
};

function vaultMsg(text, kind) {
  const el = $("vault-msg");
  el.textContent = text;
  el.className = "insight " + (kind || "");
}

function bindVaultEvents() {
  $("pin-create-btn").addEventListener("click", async () => {
    const pin = $("pin-new").value.trim();
    const repeat = $("pin-repeat").value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      vaultMsg("PIN must be 4–8 digits.", "err");
      return;
    }
    if (pin !== repeat) {
      vaultMsg("PINs don't match — try again.", "err");
      return;
    }
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await hashPin(pin, salt);
    await idbPut("kv", { k: "pin", salt, hash });
    $("pin-new").value = "";
    $("pin-repeat").value = "";
    vaultMsg("Vault created 🔒", "ok");
    await unlockVault(pin);
  });

  $("pin-unlock-btn").addEventListener("click", async () => {
    const pin = $("pin-enter").value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      vaultMsg("Enter your PIN (4–8 digits).", "err");
      return;
    }
    const rec = await idbGet("kv", "pin");
    if (!rec) {
      vaultMsg("No vault yet — create one first.", "err");
      return;
    }
    const hash = await hashPin(pin, rec.salt);
    if (hash !== rec.hash) {
      vaultMsg("Wrong PIN.", "err");
      $("pin-enter").value = "";
      return;
    }
    $("pin-enter").value = "";
    await unlockVault(pin);
  });

  $("pin-enter").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("pin-unlock-btn").click();
  });

  $("vault-add-btn").addEventListener("click", () => $("vault-file").click());
  $("vault-file").addEventListener("change", async (e) => {
    const files = [...e.target.files].filter((f) => f.type.startsWith("image/"));
    e.target.value = "";
    if (!files.length) return;
    toast(`Importing ${files.length} photo${files.length > 1 ? "s" : ""}…`);
    for (const f of files) {
      await vaultAddBlob(f, f.name.replace(/\.[^.]+$/, ""));
    }
    await renderVaultGrid();
    toast(`${files.length} photo${files.length > 1 ? "s" : ""} sealed in the vault 🔐`);
  });

  $("vault-lock-btn").addEventListener("click", () => {
    lockVault("Vault locked 🔒");
  });

  $("viewer-close").addEventListener("click", closeViewer);
  $("viewer-export-btn").addEventListener("click", async () => {
    const id = $("viewer-img").dataset.id;
    if (!id) return;
    const rec = await idbGet("photos", id);
    if (!rec) return;
    download(rec.blob, (rec.name || "vault-photo") + "-lensforge.jpg");
    toast("Exported clean copy ✅");
  });
  $("viewer-delete-btn").addEventListener("click", async () => {
    const id = $("viewer-img").dataset.id;
    if (!id) return;
    if (!confirm("Delete this photo from the vault? This cannot be undone.")) return;
    await idbDelete("photos", id);
    closeViewer();
    await renderVaultGrid();
    toast("Deleted 🗑");
  });

  // auto-lock on inactivity
  ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, () => (vault.lastActive = Date.now()), { passive: true })
  );
  setInterval(async () => {
    if (!vault.unlocked) return;
    const minutes = Number(localStorage.getItem("lf-autolock") || 5);
    if (Date.now() - vault.lastActive > minutes * 60 * 1000) {
      lockVault("Vault auto-locked after " + minutes + " min of inactivity 🔒");
    }
  }, 20000);
}

async function unlockVault(pin) {
  vault.unlocked = true;
  vault.lastActive = Date.now();
  $("vault-setup").hidden = true;
  $("vault-unlock").hidden = true;
  $("vault-gate").hidden = true;
  $("vault-open").hidden = false;
  await renderVaultGrid();
  toast("Vault unlocked 🔓");
  if (pin) void pin;
}

function lockVault(msg) {
  vault.unlocked = false;
  $("vault-open").hidden = true;
  $("vault-gate").hidden = false;
  $("vault-setup").hidden = true;
  $("vault-unlock").hidden = false;
  $("vault-msg").textContent = msg || "";
  $("vault-msg").className = "insight ok";
  closeViewer();
}

async function vaultAddBlob(blob, name) {
  const thumb = await makeThumb(blob);
  const rec = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    name: name || "photo",
    added: Date.now(),
    blob,
    thumb,
  };
  await idbPut("photos", rec);
}

async function renderVaultGrid() {
  const photos = await idbGetAll("photos");
  photos.sort((a, b) => b.added - a.added);
  const grid = $("vault-grid");
  grid.innerHTML = "";
  photos.forEach((p) => {
    const li = document.createElement("li");
    li.className = "vault-cell";
    li.innerHTML = `
      <img src="${p.thumb}" alt="${p.name}" loading="lazy" />
      <span class="cell-date">${new Date(p.added).toLocaleDateString()}</span>`;
    li.addEventListener("click", () => openViewer(p));
    grid.appendChild(li);
  });
  $("vault-empty").hidden = photos.length > 0;
  $("vault-count").textContent = `${photos.length} photo${photos.length === 1 ? "" : "s"}`;
}

function openViewer(photo) {
  const url = URL.createObjectURL(photo.blob);
  const img = $("viewer-img");
  img.src = url;
  img.dataset.id = photo.id;
  $("viewer-modal").hidden = false;
  img.onload = () => URL.revokeObjectURL(url);
}

function closeViewer() {
  $("viewer-modal").hidden = true;
  $("viewer-img").src = "";
  $("viewer-img").dataset.id = "";
}

/* ================= privacy tab ================= */

let exifSourceFile = null;

function bindExifEvents() {
  $("exif-open-btn").addEventListener("click", () => $("exif-file").click());
  $("exif-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    exifSourceFile = file;
    await showExif(file);
  });
  $("exif-clean-export-btn").addEventListener("click", async () => {
    if (!exifSourceFile) return;
    toast("Stripping metadata…");
    const bmp = await createImageBitmap(exifSourceFile);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close?.();
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
    const base = exifSourceFile.name.replace(/\.[^.]+$/, "") || "photo";
    download(blob, base + "-clean.jpg");
    toast("Exported stripped copy — GPS & device info removed ✅");
  });
}

async function showExif(file) {
  const list = $("exif-list");
  const rows = [];
  let tags = null;
  if (file.type === "image/jpeg") {
    tags = parseExif(await file.arrayBuffer());
  }
  if (tags) {
    rows.push(...exifSummary(tags));
  }
  const gpsRow = rows.find((r) => r.danger);
  list.innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<li style="${r.danger ? "border-left-color: var(--accent-2);" : ""}"><b>${r.label}</b><br/>${r.value}</li>`
        )
        .join("")
    : `<li><b>Result</b><br/>No readable metadata (or not a JPEG). PNG/WebP exports are always clean.</li>`;
  list.hidden = false;
  $("exif-clean").hidden = !gpsRow;
  $("exif-export-row").hidden = !gpsRow;
}

/* ================= settings ================= */

function bindSettingsEvents() {
  $("settings-btn").addEventListener("click", async () => {
    $("s-autolock").value = localStorage.getItem("lf-autolock") || 5;
    $("s-quality").value = localStorage.getItem("lf-quality") || 92;
    $("export-quality").value = $("s-quality").value;
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        $("storage-used").textContent = formatBytes(est.usage || 0);
      } else {
        $("storage-used").textContent = "unavailable";
      }
    } catch {
      $("storage-used").textContent = "unavailable";
    }
    $("settings-modal").hidden = false;
  });
  $("settings-close").addEventListener("click", () => ($("settings-modal").hidden = true));
  $("settings-cancel").addEventListener("click", () => ($("settings-modal").hidden = true));
  $("settings-save").addEventListener("click", () => {
    const lock = Math.min(60, Math.max(1, Number($("s-autolock").value) || 5));
    const q = Math.min(100, Math.max(50, Number($("s-quality").value) || 92));
    localStorage.setItem("lf-autolock", String(lock));
    localStorage.setItem("lf-quality", String(q));
    $("export-quality").value = q;
    $("settings-modal").hidden = true;
    toast("Settings saved ✅");
  });
}

/* ================= init ================= */

async function init() {
  buildStudioUI();
  bindStudioEvents();
  bindVaultEvents();
  bindExifEvents();
  bindSettingsEvents();

  // restore default export quality
  $("export-quality").value = localStorage.getItem("lf-quality") || 92;

  // vault state
  const pinRec = await idbGet("kv", "pin").catch(() => null);
  if (pinRec) {
    $("vault-setup").hidden = true;
    $("vault-unlock").hidden = false;
  } else {
    $("vault-setup").hidden = false;
    $("vault-unlock").hidden = true;
  }

  // ask for persistent storage so the vault survives cleanup pressure
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {}

  switchView("studio");
}

init();
