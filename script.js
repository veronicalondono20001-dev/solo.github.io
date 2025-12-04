import * as THREE from "https://esm.sh/three@0.175.0";
import { EffectComposer } from "https://esm.sh/three@0.175.0/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "https://esm.sh/three@0.175.0/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://esm.sh/three@0.175.0/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "https://esm.sh/three@0.175.0/examples/jsm/postprocessing/ShaderPass.js";

// Initialize the scene
let renderer, scene, camera;
let composer, bloomPass, filmGrainPass;
let fluidMaterial, fluidMesh;
const startTime = Date.now();
const mousePosition = new THREE.Vector2(0.5, 0.5);
const prevMousePositions = [];
const MAX_TRAIL_LENGTH = 20; // Number of previous positions to track

// Mouse movement tracking
let lastMouseMoveTime = Date.now();
let isMouseMoving = false;
const mouseVelocity = new THREE.Vector2(0, 0);
const lastMousePosition = new THREE.Vector2(0.5, 0.5);
let fadeOpacity = 1.0;
const FADE_DELAY = 1000; // ms before starting to fade out
const FADE_DURATION = 1500; // ms to complete fade
const INERTIA_FACTOR = 0.95; // How quickly velocity decreases (0-1)

// Film grain shader
const FilmGrainShader = {
  uniforms: {
    tDiffuse: { value: null },
    iTime: { value: 0 },
    iResolution: { value: new THREE.Vector3() },
    intensity: { value: 0.075 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float iTime;
    uniform vec3 iResolution;
    uniform float intensity;
    
    varying vec2 vUv;
    
    // Film grain parameters
    #define SHOW_NOISE 0
    #define SRGB 0
    // 0: Addition, 1: Screen, 2: Overlay, 3: Soft Light, 4: Lighten-Only
    #define BLEND_MODE 0
    #define SPEED 2.0
    // What gray level noise should tend to.
    #define MEAN 0.0
    // Controls the contrast/variance of noise.
    #define VARIANCE 0.5
    
    vec3 channel_mix(vec3 a, vec3 b, vec3 w) {
      return vec3(mix(a.r, b.r, w.r), mix(a.g, b.g, w.g), mix(a.b, b.b, w.b));
    }
    
    float gaussian(float z, float u, float o) {
      return (1.0 / (o * sqrt(2.0 * 3.1415))) * exp(-(((z - u) * (z - u)) / (2.0 * (o * o))));
    }
    
    vec3 madd(vec3 a, vec3 b, float w) {
      return a + a * b * w;
    }
    
    vec3 screen(vec3 a, vec3 b, float w) {
      return mix(a, vec3(1.0) - (vec3(1.0) - a) * (vec3(1.0) - b), w);
    }
    
    vec3 overlay(vec3 a, vec3 b, float w) {
      return mix(a, channel_mix(
        2.0 * a * b,
        vec3(1.0) - 2.0 * (vec3(1.0) - a) * (vec3(1.0) - b),
        step(vec3(0.5), a)
      ), w);
    }
    
    vec3 soft_light(vec3 a, vec3 b, float w) {
      return mix(a, pow(a, pow(vec3(2.0), 2.0 * (vec3(0.5) - b))), w);
    }
    
    void main() {
      vec2 ps = vec2(1.0) / iResolution.xy;
      vec2 uv = vUv;
      vec4 color = texture2D(tDiffuse, uv);
      
      #if SRGB
      color = pow(color, vec4(2.2));
      #endif
      
      float t = iTime * float(SPEED);
      float seed = dot(uv, vec2(12.9898, 78.233));
      float noise = fract(sin(seed) * 43758.5453 + t);
      noise = gaussian(noise, float(MEAN), float(VARIANCE) * float(VARIANCE));
      
      #if SHOW_NOISE
      color = vec4(noise);
      #else    
      float w = intensity;
      
      vec3 grain = vec3(noise) * (1.0 - color.rgb);
      
      #if BLEND_MODE == 0
      color.rgb += grain * w;
      #elif BLEND_MODE == 1
      color.rgb = screen(color.rgb, grain, w);
      #elif BLEND_MODE == 2
      color.rgb = overlay(color.rgb, grain, w);
      #elif BLEND_MODE == 3
      color.rgb = soft_light(color.rgb, grain, w);
      #elif BLEND_MODE == 4
      color.rgb = max(color.rgb, grain * w);
      #endif
          
      #if SRGB
      color = pow(color, vec4(1.0 / 2.2));
      #endif
      #endif
      
      gl_FragColor = color;
    }
  `
};

// Initialize the scene
function init() {
  // Create renderer
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false // No alpha to ensure solid black background
  });
  renderer.setClearColor(0x000000, 1); // Set clear color to black
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.getElementById("fluid").appendChild(renderer.domElement);

  // Create scene and camera
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000); // Set scene background to black
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Initialize previous mouse positions
  for (let i = 0; i < MAX_TRAIL_LENGTH; i++) {
    prevMousePositions.push(new THREE.Vector2(0.5, 0.5));
  }

  // Create fluid material with the shader
  fluidMaterial = new THREE.ShaderMaterial({
    uniforms: {
      iTime: { value: 0 },
      iResolution: {
        value: new THREE.Vector3(window.innerWidth, window.innerHeight, 1)
      },
      iMouse: { value: new THREE.Vector2(0.5, 0.5) },
      iPrevMouse: {
        value: Array(MAX_TRAIL_LENGTH)
          .fill()
          .map(() => new THREE.Vector2(0.5, 0.5))
      },
      iOpacity: { value: 1.0 } // Uniform for fade effect
    },
    vertexShader: `
      varying vec2 vUv;
      
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float iTime;
      uniform vec3 iResolution;
      uniform vec2 iMouse;
      uniform vec2 iPrevMouse[${MAX_TRAIL_LENGTH}];
      uniform float iOpacity;
      
      varying vec2 vUv;
      
      #define EPS .001
      
      #define TM iTime * 1.75
      #define FT 0.0025 // Constant value instead of time-based hash
      #define CI vec3(1) // White color
      
      float hash(in float n) { return fract(sin(n)*43758.5453123); }
      
      float hash(vec2 p)
      {
          return fract(sin(dot(p,vec2(127.1,311.7))) * 43758.5453123);
      }
      
      float noise(vec2 p)
      {
          vec2 i = floor(p), f = fract(p); 
          f *= f*f*(3.-2.*f);
          return mix(mix(hash(i + vec2(0.,0.)), 
                         hash(i + vec2(1.,0.)), f.x),
                     mix(hash(i + vec2(0.,1.)), 
                         hash(i + vec2(1.,1.)), f.x), f.y);
      }
      
      float fbm(in vec2 p)
      {
          return  .5000 * noise(p)
                 +.2500 * noise(p * 2.)
                 +.1250 * noise(p * 4.)
                 +.0625 * noise(p * 8.);
      }
      
      float metaball(vec2 p, float r)
      {
          return vec2(noise(vec2(FT,1)/r)).x / dot(p, p);
      }
      
      vec3 blob(vec2 p, vec2 mousePos, float intensity)
      {
          // Calculate distance from current position to mouse position
          vec2 distToMouse = p - mousePos;
          
          // Create a single metaball at the mouse position
          float r = metaball(distToMouse, 0.5); // Remove time-based noise
          
          // Amplify the effect
          r = max(r, 0.2);
          r *= FT * 2.0 * intensity;
          
          // Use white color for the metaball
          vec3 white_color = vec3(1.0, 1.0, 1.0);
          
          return (r > 0.5)
              ? (vec3(step(0.1, r*r*r)) * CI)
              : (r < 1000.9 ? white_color * r : vec3(0.0));
      }
      
      vec3 texsample(vec2 uv, vec2 mousePos, vec2 prevPositions[${MAX_TRAIL_LENGTH}])
      {
          vec3 c = vec3(0);
          
          // Add the current metaball with full intensity
          c += blob(uv, mousePos, 1.0);
          
          // Add trail metaballs with decreasing intensity
          for (int i = 0; i < ${MAX_TRAIL_LENGTH}; i++) {
              float trailIntensity = 1.0 - float(i) / float(${MAX_TRAIL_LENGTH});
              c += blob(uv, prevPositions[i], trailIntensity * 0.7);
          }
          
          return c;
      }
      
      void main() {
          // Convert from 0-1 to -1 to 1 range and maintain aspect ratio
          vec2 uv = (gl_FragCoord.xy / iResolution.xy * 2.0 - 1.0)
                  * vec2(iResolution.x / iResolution.y, 1.0);
          
          // Convert mouse from 0-1 to the same coordinate system as uv
          vec2 mousePos = (iMouse * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0);
          
          // Convert previous mouse positions
          vec2 prevPositions[${MAX_TRAIL_LENGTH}];
          for (int i = 0; i < ${MAX_TRAIL_LENGTH}; i++) {
              prevPositions[i] = (iPrevMouse[i] * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0);
          }
          
          vec3 color = texsample(uv, mousePos, prevPositions);
          
          // Apply fade effect
          gl_FragColor = vec4(color * iOpacity, 1.0);
      }
    `,
    transparent: false
  });

  // Create a plane for the fluid
  const geometry = new THREE.PlaneGeometry(2, 2);
  fluidMesh = new THREE.Mesh(geometry, fluidMaterial);
  scene.add(fluidMesh);

  // Set up post-processing
  composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // Add bloom effect
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.0, // strength
    0.7, // radius
    0.2 // threshold
  );
  composer.addPass(bloomPass);

  // Add film grain effect
  filmGrainPass = new ShaderPass(FilmGrainShader);
  filmGrainPass.uniforms.iResolution.value.set(
    window.innerWidth,
    window.innerHeight,
    1
  );
  composer.addPass(filmGrainPass);

  // Event listeners
  window.addEventListener("resize", onWindowResize);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("touchstart", onTouchStart, { passive: false });
  window.addEventListener("touchmove", onTouchMove, { passive: false });

  // Start animation
  animate();
}

function onWindowResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  camera.left = -1;
  camera.right = 1;
  camera.top = 1;
  camera.bottom = -1;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height);
  composer.setSize(width, height);

  fluidMaterial.uniforms.iResolution.value.set(width, height, 1);
  filmGrainPass.uniforms.iResolution.value.set(width, height, 1);
}

function updateMousePosition(clientX, clientY) {
  // Get the canvas element's bounding rectangle
  const canvas = renderer.domElement;
  const rect = canvas.getBoundingClientRect();

  // Calculate normalized mouse position (0 to 1) using the canvas bounds
  // This is more accurate across browsers than using window dimensions
  const newMouseX = (clientX - rect.left) / rect.width;
  const newMouseY = 1.0 - (clientY - rect.top) / rect.height; // Flip Y for shader

  // Calculate velocity (how fast the mouse is moving)
  mouseVelocity.x = newMouseX - mousePosition.x;
  mouseVelocity.y = newMouseY - mousePosition.y;

  // Update mouse position
  mousePosition.x = newMouseX;
  mousePosition.y = newMouseY;

  // Update last mouse position
  lastMousePosition.copy(mousePosition);

  // Mark mouse as moving and update time
  isMouseMoving = true;
  lastMouseMoveTime = Date.now();

  // If we were faded out, start fading in
  if (fadeOpacity < 1.0) {
    fadeOpacity = Math.min(fadeOpacity + 0.1, 1.0);
  }

  // Update shader uniforms
  fluidMaterial.uniforms.iMouse.value.copy(mousePosition);
  fluidMaterial.uniforms.iOpacity.value = fadeOpacity;
}

function onMouseMove(event) {
  updateMousePosition(event.clientX, event.clientY);
}

function onTouchStart(event) {
  if (event.touches.length > 0) {
    event.preventDefault();
    const touch = event.touches[0];
    updateMousePosition(touch.clientX, touch.clientY);
  }
}

function onTouchMove(event) {
  if (event.touches.length > 0) {
    event.preventDefault();
    const touch = event.touches[0];
    updateMousePosition(touch.clientX, touch.clientY);
  }
}

function updateTrailPositions() {
  // If mouse is not moving, apply velocity with inertia
  if (!isMouseMoving) {
    // Apply velocity with inertia (gradually slowing down)
    mouseVelocity.multiplyScalar(INERTIA_FACTOR);

    // Only update if velocity is significant
    if (mouseVelocity.length() > 0.0001) {
      // Update position based on velocity
      mousePosition.x += mouseVelocity.x;
      mousePosition.y += mouseVelocity.y;

      // Keep within bounds
      mousePosition.x = Math.max(0, Math.min(1, mousePosition.x));
      mousePosition.y = Math.max(0, Math.min(1, mousePosition.y));

      // Update shader uniform
      fluidMaterial.uniforms.iMouse.value.copy(mousePosition);
    }
  }

  // Update previous positions (shift array)
  prevMousePositions.pop(); // Remove oldest position
  prevMousePositions.unshift(mousePosition.clone()); // Add current position to front

  // Update previous positions in shader
  for (let i = 0; i < MAX_TRAIL_LENGTH; i++) {
    fluidMaterial.uniforms.iPrevMouse.value[i].copy(prevMousePositions[i]);
  }
}

function updateFadeEffect() {
  const currentTime = Date.now();
  const timeSinceLastMove = currentTime - lastMouseMoveTime;

  // If mouse hasn't moved for a while, start fading out
  if (timeSinceLastMove > FADE_DELAY) {
    // Calculate fade based on time
    const fadeProgress = Math.min(
      1,
      (timeSinceLastMove - FADE_DELAY) / FADE_DURATION
    );
    fadeOpacity = 1.0 - fadeProgress;

    // Update shader uniform
    fluidMaterial.uniforms.iOpacity.value = Math.max(0, fadeOpacity);
  }

  // Reset mouse moving flag if velocity is very low
  if (mouseVelocity.length() < 0.0001) {
    isMouseMoving = false;
  }
}

function animate() {
  requestAnimationFrame(animate);

  // Update trail positions with inertia
  updateTrailPositions();

  // Update fade effect
  updateFadeEffect();

  // Update time
  const elapsedTime = (Date.now() - startTime) / 1000;
  fluidMaterial.uniforms.iTime.value = elapsedTime;
  filmGrainPass.uniforms.iTime.value = elapsedTime;

  // Render
  composer.render();
}

// Initialize on load
window.addEventListener("load", init);