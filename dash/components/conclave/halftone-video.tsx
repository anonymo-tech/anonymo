'use client';

import { useEffect, useRef, type RefObject } from 'react';
import './halftone-video.css';

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uVideo;
uniform vec2 uResolution;
uniform vec2 uVideoSize;
uniform float uCellPx;
out vec4 outColor;

vec2 coverUV(vec2 uv) {
  float screenAspect = uResolution.x / uResolution.y;
  float videoAspect = uVideoSize.x / uVideoSize.y;
  vec2 scale = screenAspect < videoAspect
    ? vec2(screenAspect / videoAspect, 1.0)
    : vec2(1.0, videoAspect / screenAspect);
  return clamp((uv - 0.5) * scale + 0.5, 0.0, 1.0);
}

float grain(vec2 position) {
  return fract(sin(dot(position, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  // A fixed 45-degree print screen: each dot samples its own video cell.
  const float diagonal = 0.70710678;
  mat2 screen = mat2(diagonal, diagonal, -diagonal, diagonal);
  vec2 grid = screen * gl_FragCoord.xy / uCellPx;
  vec2 cell = floor(grid) + 0.5;
  vec2 samplePosition = transpose(screen) * (cell * uCellPx);
  vec3 source = texture(uVideo, coverUV(samplePosition / uResolution)).rgb;
  float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
  luminance = pow(clamp((luminance - 0.035) * 1.12, 0.0, 1.0), 0.88);
  float inkAmount = 1.0 - luminance;
  // Circle area tracks darkness through the midtones; deepest dots merge.
  float radius = sqrt(inkAmount / 3.14159265);
  radius = mix(radius, 0.8, smoothstep(0.78, 1.0, inkAmount));
  float distanceToCenter = length(grid - cell);
  float edge = max(0.5 * fwidth(distanceToCenter), 0.008);
  float dotInk = 1.0 - smoothstep(radius - edge, radius + edge, distanceToCenter);
  dotInk *= smoothstep(0.0, 0.02, inkAmount);
  vec3 ivory = vec3(0.945, 0.929, 0.885);
  vec3 ink = vec3(0.055, 0.057, 0.049);
  // Grain is anchored to the screen, never a flickering animation.
  float paperGrain = (grain(floor(gl_FragCoord.xy)) - 0.5) * 0.022;
  outColor = vec4(clamp(mix(ivory, ink, dotInk) + paperGrain, 0.0, 1.0), 1.0);
}`;

type Pipeline = {
  program: WebGLProgram;
  texture: WebGLTexture;
  vertices: WebGLBuffer;
  vertexArray: WebGLVertexArrayObject;
  resolution: WebGLUniformLocation;
  videoSize: WebGLUniformLocation;
  cellPx: WebGLUniformLocation;
};

function createPipeline(gl: WebGL2RenderingContext): Pipeline | null {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let texture: WebGLTexture | null = null;
  let vertices: WebGLBuffer | null = null;
  let vertexArray: WebGLVertexArrayObject | null = null;

  function compile(kind: number, source: string) {
    const shader = gl.createShader(kind);
    if (!shader) throw new Error('Shader unavailable');
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('Shader compilation unavailable');
    }
    return shader;
  }

  try {
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram();
    if (!program) throw new Error('Program unavailable');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program linking unavailable');
    }
    texture = gl.createTexture();
    vertices = gl.createBuffer();
    vertexArray = gl.createVertexArray();
    const resolution = gl.getUniformLocation(program, 'uResolution');
    const videoSize = gl.getUniformLocation(program, 'uVideoSize');
    const cellPx = gl.getUniformLocation(program, 'uCellPx');
    if (
      !texture ||
      !vertices ||
      !vertexArray ||
      !resolution ||
      !videoSize ||
      !cellPx
    ) {
      throw new Error('Shader resources unavailable');
    }

    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(program, 'uVideo'), 0);
    return {
      program,
      texture,
      vertices,
      vertexArray,
      resolution,
      videoSize,
      cellPx,
    };
  } catch {
    if (program) gl.deleteProgram(program);
    if (texture) gl.deleteTexture(texture);
    if (vertices) gl.deleteBuffer(vertices);
    if (vertexArray) gl.deleteVertexArray(vertexArray);
    return null;
  } finally {
    shaders.forEach((shader) => gl.deleteShader(shader));
  }
}

function destroyPipeline(
  gl: WebGL2RenderingContext,
  pipeline: Pipeline | null,
) {
  if (!pipeline) return;
  gl.deleteTexture(pipeline.texture);
  gl.deleteBuffer(pipeline.vertices);
  gl.deleteVertexArray(pipeline.vertexArray);
  gl.deleteProgram(pipeline.program);
}

/** Decorative sibling of a positioned, object-fit: cover video. */
export function HalftoneVideo({
  videoRef,
  paused = false,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  paused?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  const synchronizeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
    synchronizeRef.current?.();
  }, [paused]);

  useEffect(() => {
    const canvasElement = canvasRef.current;
    const videoElement = videoRef.current;
    if (!canvasElement || !videoElement) return;
    const canvas = canvasElement;
    const video = videoElement;

    const context = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
    if (!context) {
      canvas.dataset.halftone = 'fallback';
      return;
    }
    const gl = context;
    // Naming this WebGL binding avoids confusing it with a React use* hook.
    const bindProgram = gl.useProgram.bind(gl);
    let pipeline = createPipeline(gl);
    if (!pipeline) {
      canvas.dataset.halftone = 'fallback';
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let inView = false;
    let failed = false;
    let frameRequest: number | null = null;
    let animationRequest: number | null = null;
    let lastMediaTime = -1;
    let lastAnimationTime = 0;
    let pixelRatio = 1;

    const stop = () => {
      if (frameRequest !== null) video.cancelVideoFrameCallback(frameRequest);
      if (animationRequest !== null)
        window.cancelAnimationFrame(animationRequest);
      frameRequest = null;
      animationRequest = null;
    };

    const fail = () => {
      failed = true;
      stop();
      canvas.dataset.halftone = 'fallback';
    };

    function draw() {
      if (
        disposed ||
        failed ||
        !pipeline ||
        !inView ||
        document.hidden ||
        gl.isContextLost()
      )
        return;
      if (
        video.readyState < 2 ||
        !video.videoWidth ||
        !video.videoHeight ||
        video.error
      )
        return;
      if (!canvas.width || !canvas.height) return;
      try {
        bindProgram(pipeline.program);
        gl.bindVertexArray(pipeline.vertexArray);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pipeline.texture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGB,
          gl.RGB,
          gl.UNSIGNED_BYTE,
          video,
        );
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(pipeline.resolution, canvas.width, canvas.height);
        gl.uniform2f(pipeline.videoSize, video.videoWidth, video.videoHeight);
        gl.uniform1f(
          pipeline.cellPx,
          (window.innerWidth <= 600 ? 3 : 5) * pixelRatio,
        );
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (gl.getError() !== gl.NO_ERROR) {
          fail();
          return;
        }
        lastMediaTime = video.currentTime;
        canvas.dataset.halftone = 'ready';
      } catch {
        // CORS, decoding or GPU failures expose the unchanged source video.
        fail();
      }
    }

    function canAnimate() {
      return (
        !disposed &&
        !failed &&
        !!pipeline &&
        inView &&
        !document.hidden &&
        !pausedRef.current &&
        !reducedMotion.matches &&
        !video.paused &&
        !video.ended
      );
    }

    function schedule() {
      if (!canAnimate() || frameRequest !== null || animationRequest !== null)
        return;
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameRequest = video.requestVideoFrameCallback(() => {
          frameRequest = null;
          if (!canAnimate()) return;
          draw();
          schedule();
        });
      } else {
        animationRequest = window.requestAnimationFrame((time) => {
          animationRequest = null;
          if (!canAnimate()) return;
          // Older browsers get a capped fallback, skipping unchanged frames.
          if (
            time - lastAnimationTime >= 1000 / 30 &&
            video.currentTime !== lastMediaTime
          ) {
            lastAnimationTime = time;
            draw();
          }
          schedule();
        });
      }
    }

    function synchronize() {
      stop();
      draw();
      schedule();
    }

    function resize() {
      pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.round(canvas.clientWidth * pixelRatio);
      const height = Math.round(canvas.clientHeight * pixelRatio);
      if (
        width > 0 &&
        height > 0 &&
        (canvas.width !== width || canvas.height !== height)
      ) {
        canvas.width = width;
        canvas.height = height;
        // Resizing clears the backing store; never show an undrawn opaque canvas.
        canvas.dataset.halftone = 'pending';
      }
      synchronize();
    }

    const clear = () => {
      stop();
      canvas.dataset.halftone = 'pending';
      lastMediaTime = -1;
    };
    const lost = (event: Event) => {
      event.preventDefault();
      fail();
    };
    const restored = () => {
      pipeline = createPipeline(gl);
      failed = !pipeline;
      resize();
    };
    const sourceReady = () => {
      if (video.error) return;
      // A new media source can recover from a previous video error.
      if (pipeline && !gl.isContextLost()) failed = false;
      synchronize();
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
        synchronize();
      },
      { threshold: 0 },
    );
    const resizeObserver = new ResizeObserver(resize);
    observer.observe(canvas);
    resizeObserver.observe(canvas);
    synchronizeRef.current = synchronize;
    video.addEventListener('loadeddata', sourceReady);
    video.addEventListener('seeked', synchronize);
    video.addEventListener('playing', synchronize);
    video.addEventListener('pause', synchronize);
    video.addEventListener('ended', synchronize);
    video.addEventListener('emptied', clear);
    video.addEventListener('error', fail);
    document.addEventListener('visibilitychange', synchronize);
    window.addEventListener('resize', resize);
    reducedMotion.addEventListener('change', synchronize);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    resize();

    return () => {
      disposed = true;
      synchronizeRef.current = null;
      stop();
      observer.disconnect();
      resizeObserver.disconnect();
      video.removeEventListener('loadeddata', sourceReady);
      video.removeEventListener('seeked', synchronize);
      video.removeEventListener('playing', synchronize);
      video.removeEventListener('pause', synchronize);
      video.removeEventListener('ended', synchronize);
      video.removeEventListener('emptied', clear);
      video.removeEventListener('error', fail);
      document.removeEventListener('visibilitychange', synchronize);
      window.removeEventListener('resize', resize);
      reducedMotion.removeEventListener('change', synchronize);
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      destroyPipeline(gl, pipeline);
      canvas.dataset.halftone = 'pending';
    };
  }, [videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className="conclave-halftone-video"
      data-halftone="pending"
      aria-hidden="true"
    />
  );
}
