import {
  Box3,
  Color,
  Group,
  Mesh,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from 'three';
import { createIconModelKit } from './icon-model-kit';
import { buildPrimaryIcon } from './icon-models-primary';
import { buildSecondaryIcon } from './icon-models-secondary';
import { buildUtilityIcon } from './icon-models-utility';

const vertexShader = `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragmentShader = `
  varying vec3 vNormal;
  uniform vec3 uPaper;
  uniform vec3 uScarlet;
  uniform float uAccent;
  uniform float uInk;
  uniform float uDensity;
  void main() {
    vec3 n = normalize(vNormal);
    float key = max(dot(n, normalize(vec3(-0.6, 0.8, 1.1))), 0.0);
    float rim = pow(1.0 - abs(n.z), 3.0) * 0.22;
    float light = clamp(0.10 + key * 0.88 + rim, 0.0, 1.0);
    vec2 grid = mat2(0.7071, -0.7071, 0.7071, 0.7071) * gl_FragCoord.xy;
    vec2 cell = fract(grid / uDensity) - 0.5;
    float radius = mix(0.71, 0.06, pow(light, 0.75));
    float edge = max(fwidth(length(cell)), 0.025);
    float dotInk = 1.0 - smoothstep(radius - edge, radius + edge, length(cell));
    float shadow = 1.0 - smoothstep(0.16, 0.35, light);
    float coverage = max(dotInk, shadow);
    vec3 paper = mix(uPaper, uScarlet, uAccent) * (0.67 + light * 0.33);
    vec3 ink = vec3(0.009, 0.009, 0.008) + vec3(rim * 0.09);
    vec3 color = mix(paper, ink, max(coverage, uInk * 0.93));
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

function material(ink: boolean) {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uPaper: { value: new Color('#fff8e8') },
      uScarlet: { value: new Color('#ee281c') },
      uAccent: { value: 0 },
      uInk: { value: ink ? 1 : 0 },
      uDensity: { value: 4 },
    },
  });
}

type Slot = {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  name: string;
  visible: boolean;
  dirty: boolean;
  size: number;
  hovered: boolean;
  focused: boolean;
  touchUntil: number;
  angle: number;
  accent: number;
  previous: number;
  cleanup: () => void;
};

class IconRenderer {
  private renderer = new WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: 'low-power',
  });
  private scene = new Scene();
  private camera = new PerspectiveCamera(30, 1, 0.1, 20);
  private materials = { ivory: material(false), ink: material(true) };
  private kit = createIconModelKit(this.materials);
  private models = new Map<string, Group>();
  private slots = new Map<HTMLCanvasElement, Slot>();
  private frame = 0;
  private lost = false;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private hover = matchMedia('(hover: hover) and (pointer: fine)');
  private observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const slot = this.slots.get(entry.target as HTMLCanvasElement);
      if (slot) {
        slot.visible = entry.isIntersecting;
        slot.dirty = true;
      }
    }
    this.request();
  });
  private resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const slot = this.slots.get(entry.target as HTMLCanvasElement);
      if (slot) {
        slot.size = entry.contentRect.width;
        slot.dirty = true;
      }
    }
    this.request();
  });
  private invalidate = () => {
    for (const slot of this.slots.values()) {
      slot.dirty = true;
      slot.previous = 0;
    }
    this.request();
  };
  private contextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    for (const slot of this.slots.values())
      slot.root.dataset.renderer = 'fallback';
  };
  private contextRestored = () => {
    this.lost = false;
    this.invalidate();
  };

  constructor() {
    this.camera.position.z = 5.5;
    this.renderer.setClearColor(0, 0);
    this.renderer.setPixelRatio(1);
    this.reduced.addEventListener('change', this.invalidate);
    document.addEventListener('visibilitychange', this.invalidate);
    this.renderer.domElement.addEventListener(
      'webglcontextlost',
      this.contextLost,
    );
    this.renderer.domElement.addEventListener(
      'webglcontextrestored',
      this.contextRestored,
    );
  }

  private model(name: string) {
    const cached = this.models.get(name);
    if (cached) return cached;
    const shape =
      buildPrimaryIcon(name, this.kit) ??
      buildSecondaryIcon(name, this.kit) ??
      buildUtilityIcon(name, this.kit);
    const bounds = new Box3().setFromObject(shape);
    const size = bounds.getSize(new Vector3());
    shape.position.sub(bounds.getCenter(new Vector3()));
    const fit = new Group();
    fit.add(shape);
    fit.scale.setScalar(
      2.42 / Math.max(Math.hypot(size.x, size.z), size.y + size.z * 0.16),
    );
    const rotor = new Group();
    rotor.add(fit);
    this.models.set(name, rotor);
    return rotor;
  }

  mount(root: HTMLElement, canvas: HTMLCanvasElement, name: string) {
    const context = canvas.getContext('2d');
    if (!context) return () => {};
    const owner = root.closest<HTMLElement>(
      '[data-icon-trigger], [data-icon-field]',
    );
    const control = owner instanceof HTMLLabelElement ? owner.control : null;
    const slot: Slot = {
      root,
      canvas,
      context,
      name,
      visible: false,
      dirty: true,
      size: 0,
      hovered: !!(this.hover.matches && owner?.matches(':hover')),
      focused: !!(
        owner?.matches(':focus-visible') || control?.matches(':focus-visible')
      ),
      touchUntil: 0,
      angle: 0,
      accent: 0,
      previous: 0,
      cleanup: () => {},
    };
    const disabled = () =>
      !!(
        owner?.matches(':disabled, [aria-disabled="true"]') ||
        control?.matches(':disabled')
      );
    const update = () => {
      slot.dirty = true;
      this.request();
    };
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && this.hover.matches) {
        slot.hovered = true;
        update();
      }
    };
    const leave = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') {
        slot.hovered = false;
        update();
      }
    };
    const press = (event: PointerEvent) => {
      if (
        event.isPrimary &&
        event.button === 0 &&
        !disabled() &&
        (event.pointerType === 'touch' || !this.hover.matches)
      ) {
        slot.touchUntil = performance.now() + 1600;
        update();
      }
    };
    const focus = (event: FocusEvent) => {
      slot.focused =
        event.target instanceof Element &&
        event.target.matches(':focus-visible');
      update();
    };
    const blur = (event: FocusEvent) => {
      if (
        event.relatedTarget instanceof Node &&
        owner?.contains(event.relatedTarget)
      )
        return;
      slot.focused = false;
      slot.touchUntil = 0;
      update();
    };
    const key = (event: KeyboardEvent) => {
      if (
        !event.repeat &&
        !owner?.hasAttribute('data-icon-field') &&
        (event.key === 'Enter' || event.key === ' ') &&
        !disabled()
      ) {
        slot.touchUntil = performance.now() + 1600;
        update();
      }
    };
    owner?.addEventListener('pointerenter', enter);
    owner?.addEventListener('pointerleave', leave);
    owner?.addEventListener('pointerdown', press);
    owner?.addEventListener('focusin', focus);
    owner?.addEventListener('focusout', blur);
    owner?.addEventListener('keydown', key);
    control?.addEventListener('focus', focus);
    control?.addEventListener('blur', blur);
    slot.cleanup = () => {
      owner?.removeEventListener('pointerenter', enter);
      owner?.removeEventListener('pointerleave', leave);
      owner?.removeEventListener('pointerdown', press);
      owner?.removeEventListener('focusin', focus);
      owner?.removeEventListener('focusout', blur);
      owner?.removeEventListener('keydown', key);
      control?.removeEventListener('focus', focus);
      control?.removeEventListener('blur', blur);
    };
    // Recheck disabled controls without a render-loop DOM style query.
    const isActive = () =>
      !disabled() &&
      (slot.hovered || slot.focused || slot.touchUntil > performance.now());
    this.slots.set(canvas, slot);
    this.observer.observe(canvas);
    this.resize.observe(canvas);
    this.active.set(slot, isActive);
    this.request();
    return () => {
      slot.cleanup();
      this.observer.unobserve(canvas);
      this.resize.unobserve(canvas);
      this.slots.delete(canvas);
      this.active.delete(slot);
      if (!this.slots.size) {
        this.dispose();
        engine = null;
      }
    };
  }

  private active = new Map<Slot, () => boolean>();
  private request() {
    if (!this.frame && !document.hidden && !this.lost)
      this.frame = requestAnimationFrame(this.draw);
  }
  private draw = (now: number) => {
    this.frame = 0;
    if (document.hidden || this.lost) return;
    let again = false;
    for (const slot of this.slots.values()) {
      if (!slot.visible || slot.size <= 0) {
        slot.previous = 0;
        continue;
      }
      const hot = this.active.get(slot)?.() ?? false;
      const spin = hot && !this.reduced.matches;
      const dt = slot.previous
        ? Math.min((now - slot.previous) / 1000, 0.05)
        : 1 / 60;
      slot.previous = now;
      const oldAngle = slot.angle;
      const oldAccent = slot.accent;
      slot.accent += ((hot ? 1 : 0) - slot.accent) * Math.min(1, dt * 14);
      if (this.reduced.matches) slot.angle = 0;
      else if (spin)
        slot.angle = (slot.angle + (dt * Math.PI * 2) / 2.8) % (Math.PI * 2);
      else {
        if (slot.angle > Math.PI) slot.angle -= Math.PI * 2;
        slot.angle *= Math.max(0, 1 - dt * 14);
        if (Math.abs(slot.angle) < 0.002) slot.angle = 0;
      }
      if (Math.abs(slot.accent - (hot ? 1 : 0)) < 0.002)
        slot.accent = hot ? 1 : 0;
      const changed =
        Math.abs(slot.angle - oldAngle) + Math.abs(slot.accent - oldAccent) >
        0.0001;
      if (slot.dirty || changed || spin) {
        this.render(slot);
        slot.dirty = false;
      }
      if (spin || changed || slot.touchUntil > now) again = true;
    }
    if (again) this.request();
  };

  private render(slot: Slot) {
    const dpr = Math.min(devicePixelRatio || 1, 3);
    const pixels = Math.max(
      48,
      Math.min(192, Math.ceil(slot.size * dpr * 1.25)),
    );
    if (this.renderer.domElement.width !== pixels)
      this.renderer.setSize(pixels, pixels, false);
    if (slot.canvas.width !== pixels) {
      slot.canvas.width = pixels;
      slot.canvas.height = pixels;
    }
    const model = this.model(slot.name);
    model.rotation.set(0.16, -0.32 + slot.angle, 0);
    this.scene.clear();
    this.scene.add(model);
    for (const mat of Object.values(this.materials)) {
      mat.uniforms.uAccent.value = slot.accent;
      mat.uniforms.uDensity.value = (pixels / slot.size) * 1.6;
    }
    this.renderer.render(this.scene, this.camera);
    slot.context.globalCompositeOperation = 'copy';
    slot.context.drawImage(this.renderer.domElement, 0, 0, pixels, pixels);
    slot.root.dataset.renderer = 'webgl';
  }

  private dispose() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.resize.disconnect();
    this.reduced.removeEventListener('change', this.invalidate);
    document.removeEventListener('visibilitychange', this.invalidate);
    this.renderer.domElement.removeEventListener(
      'webglcontextlost',
      this.contextLost,
    );
    this.renderer.domElement.removeEventListener(
      'webglcontextrestored',
      this.contextRestored,
    );
    for (const model of this.models.values())
      model.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose();
      });
    Object.values(this.materials).forEach((mat) => mat.dispose());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

let engine: IconRenderer | null = null;
export function mountIcon3d(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  name: string,
) {
  try {
    engine ??= new IconRenderer();
    return engine.mount(root, canvas, name);
  } catch {
    root.dataset.renderer = 'fallback';
    return () => {};
  }
}
