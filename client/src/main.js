import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.16.2/rapier.es.js';
import { mixSeed } from '/shared/dice.js';

const R = RAPIER;

const FIXED_DT = 1 / 120;
const MAX_STEPS = 1800;
const SETTLE_LINEAR = 0.035;
const SETTLE_ANGULAR = 0.06;
const SETTLE_FRAMES = 30;

const TABLE_HALF = 9.5;
const WALL_HEIGHT = 40;
const WALL_THICKNESS = 0.5;
const FLOOR_THICKNESS = 0.4;

const UP = new THREE.Vector3(0, 1, 0);

// EASY DIE SIZE CONTROLS
// Change only these numbers to tune the apparent/physics size of each die.
// These values are the current agreed settings.
const DIE_SIZE_MULTIPLIERS = {
  d4: 1.00,
  d6: 0.75,
  d8: 1.03,
  d10: 1.06,
  d12: 1.09,
  d20: 1.5
};

const els = {
  stage: document.querySelector('#stage'),
  status: document.querySelector('#status'),
  skinSelect: document.querySelector('#skinSelect'),
  expressionInput: document.querySelector('#expressionInput'),
  rollButton: document.querySelector('#rollButton'),
  resetButton: document.querySelector('#resetButton'),
  overlay: document.querySelector('#overlay'),
  overlayText: document.querySelector('#overlayText'),
  result: document.querySelector('#result'),
  resultBreakdown: document.querySelector('#resultBreakdown')
};

let faceMaps = null;
let scene = null;
let camera = null;
let renderer = null;
let clock = null;

let visibleWorld = null;
let rolling = false;
let animation = null;
let diceInstances = [];

let socket = null;

const gltfCache = new Map();
const dieMetaCache = new Map();

function setStatus(text) {
  if (els.status) els.status.textContent = text;
}

function showError(message) {
  if (els.overlay) els.overlay.classList.remove('hidden');
  if (els.overlayText) els.overlayText.textContent = message;
}

function finiteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Non-finite ${label}: ${String(value)}`);
  }
  return n;
}

function finiteVector(v, label) {
  finiteNumber(v.x, `${label}.x`);
  finiteNumber(v.y, `${label}.y`);
  finiteNumber(v.z, `${label}.z`);
}

function finiteQuaternion(q, label) {
  finiteNumber(q.x, `${label}.x`);
  finiteNumber(q.y, `${label}.y`);
  finiteNumber(q.z, `${label}.z`);
  finiteNumber(q.w, `${label}.w`);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSigned(rng) {
  return rng() * 2 - 1;
}

function randomVector(rng, scale) {
  return new THREE.Vector3(
    randomSigned(rng) * scale,
    randomSigned(rng) * scale,
    randomSigned(rng) * scale
  );
}

function randomUnitVector(rng) {
  const v = randomVector(rng, 1);
  if (v.lengthSq() < 1e-8) v.set(1, 0, 0);
  return v.normalize();
}

function randomQuaternion(rng) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      rng() * Math.PI * 2,
      rng() * Math.PI * 2,
      rng() * Math.PI * 2
    )
  );
  return q.normalize();
}

function createRenderer() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0c10);

  camera = new THREE.PerspectiveCamera(
    45,
    els.stage.clientWidth / els.stage.clientHeight,
    0.1,
    100
  );
  camera.position.set(0, 24, 0.001);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(els.stage.clientWidth, els.stage.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  els.stage.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x202431, 2.4));

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(5, 10, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xaec7ff, 1.1);
  fill.position.set(-6, 5, -7);
  scene.add(fill);

  clock = new THREE.Clock();
  window.addEventListener('resize', resize);
  requestAnimationFrame(animate);
}

function resize() {
  if (!renderer) return;
  const width = els.stage.clientWidth;
  const height = els.stage.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

function animate() {
  requestAnimationFrame(animate);
  const frameDt = Math.min(clock.getDelta(), 0.05);

  if (animation && visibleWorld) {
    animation.accumulator += frameDt;

    while (animation.accumulator >= FIXED_DT) {
      visibleWorld.step();
      animation.accumulator -= FIXED_DT;

      let allSettled = true;

      for (const die of diceInstances) {
        syncDieVisual(die);

        const state = readBodyState(die.body);
        if (findNonFiniteState(state)) {
          animation = null;
          rolling = false;
          els.rollButton.disabled = false;
          setStatus('Physics error');
          showError(`Physics produced a non-finite state for ${die.id}.`);
          break;
        }

        const v = velocityMagnitudes(state);
        if (v.linear < SETTLE_LINEAR && v.angular < SETTLE_ANGULAR) {
          die.settledFrames++;
        } else {
          die.settledFrames = 0;
        }

        if (!die.settled && die.settledFrames >= SETTLE_FRAMES) {
          const rotation = new THREE.Quaternion(
            state.rotation.x,
            state.rotation.y,
            state.rotation.z,
            state.rotation.w
          );

          const face = inspectFaces(die.dieType, rotation)[0];
          die.result = face.number;
          die.faceId = face.faceId;
          die.settled = true;
        }

        if (!die.settled) allSettled = false;
      }

      if (!rolling || !animation) break;

      if (diceInstances.length > 0 && allSettled) {
        finishRoll();
        break;
      }
    }
  }

  if (renderer) renderer.render(scene, camera);
}

function syncDieVisual(die) {
  const p = die.body.translation();
  const r = die.body.rotation();
  die.visual.position.set(p.x, p.y, p.z);
  die.visual.quaternion.set(r.x, r.y, r.z, r.w);
}

function addTableVisual() {
  const group = new THREE.Group();

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE_HALF * 2, 0.25, TABLE_HALF * 2),
    new THREE.MeshStandardMaterial({ color: 0x30251f, roughness: 0.92 })
  );
  floor.position.y = -0.125;
  floor.receiveShadow = true;
  group.add(floor);

  const rim = new THREE.MeshStandardMaterial({ color: 0x17191f, roughness: 0.8 });
  const pieces = [
    [0, -TABLE_HALF - 0.12, TABLE_HALF * 2 + 0.24, 0.22],
    [0, TABLE_HALF + 0.12, TABLE_HALF * 2 + 0.24, 0.22],
    [-TABLE_HALF - 0.12, 0, 0.22, TABLE_HALF * 2 + 0.24],
    [TABLE_HALF + 0.12, 0, 0.22, TABLE_HALF * 2 + 0.24]
  ];

  for (const [x, z, sx, sz] of pieces) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.55, sz), rim);
    mesh.position.set(x, 0.275, z);
    mesh.castShadow = true;
    group.add(mesh);
  }

  scene.add(group);
}

function buildRapierArena(world) {
  const floorBody = world.createRigidBody(
    R.RigidBodyDesc.fixed().setTranslation(0, -FLOOR_THICKNESS / 2, 0)
  );

  world.createCollider(
    R.ColliderDesc.cuboid(
      TABLE_HALF + WALL_THICKNESS,
      FLOOR_THICKNESS / 2,
      TABLE_HALF + WALL_THICKNESS
    ).setFriction(0.65).setRestitution(0.22),
    floorBody
  );

  const wallY = WALL_HEIGHT / 2;
  const offset = TABLE_HALF + WALL_THICKNESS / 2;
  const longHalf = TABLE_HALF + WALL_THICKNESS;
  const shortHalf = WALL_THICKNESS / 2;

  const walls = [
    [0, wallY, -offset, longHalf, wallY, shortHalf],
    [0, wallY, offset, longHalf, wallY, shortHalf],
    [-offset, wallY, 0, shortHalf, wallY, TABLE_HALF],
    [offset, wallY, 0, shortHalf, wallY, TABLE_HALF]
  ];

  for (const [x, y, z, hx, hy, hz] of walls) {
    const body = world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(x, y, z)
    );

    world.createCollider(
      R.ColliderDesc.cuboid(hx, hy, hz)
        .setFriction(0.55)
        .setRestitution(0.28),
      body
    );
  }
}

async function loadFaceMaps() {
  const response = await fetch('./assets/face-maps.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Face map HTTP ${response.status}`);

  const maps = await response.json();
  const expected = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 };

  for (const [dieType, count] of Object.entries(expected)) {
    const map = maps[dieType];
    if (!map || Object.keys(map).length !== count) {
      throw new Error(
        `Invalid ${dieType.toUpperCase()} mapping: expected ${count} faces, found ${map ? Object.keys(map).length : 0}.`
      );
    }

    for (let n = 1; n <= count; n++) {
      const face = map[String(n)];
      if (!face || !Array.isArray(face.normal) || face.normal.length !== 3) {
        throw new Error(`Malformed ${dieType.toUpperCase()} face ${n}.`);
      }
      face.normal.forEach((v, i) => finiteNumber(v, `${dieType}.${n}.normal[${i}]`));
    }
  }

  return maps;
}

async function loadGLTF(skin, dieType) {
  const cacheKey = `${skin}/${dieType}`;
  if (gltfCache.has(cacheKey)) return gltfCache.get(cacheKey).clone(true);

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(`./assets/dice/${skin}/${dieType}.glb`);
  gltfCache.set(cacheKey, gltf.scene);
  return gltf.scene.clone(true);
}

function extractVertices(object) {
  object.updateMatrixWorld(true);
  const points = [];
  const temp = new THREE.Vector3();

  object.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const positions = node.geometry.attributes.position;

    for (let i = 0; i < positions.count; i++) {
      temp.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld);
      points.push(temp.x, temp.y, temp.z);
    }
  });

  return new Float32Array(points);
}

function analyzeVertices(vertices) {
  if (!vertices.length) throw new Error('No collider vertices found.');

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < vertices.length; i += 3) {
    const x = finiteNumber(vertices[i], `vertex ${i / 3}.x`);
    const y = finiteNumber(vertices[i + 1], `vertex ${i / 3}.y`);
    const z = finiteNumber(vertices[i + 2], `vertex ${i / 3}.z`);

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  return {
    count: vertices.length / 3,
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ }
  };
}

async function getDieMeta(skin, dieType) {
  const cacheKey = `${skin}/${dieType}`;
  if (dieMetaCache.has(cacheKey)) return dieMetaCache.get(cacheKey);

  const model = await loadGLTF(skin, dieType);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const vertices = extractVertices(model);
  const maxDim = Math.max(size.x, size.y, size.z);

  if (!Number.isFinite(maxDim) || maxDim <= 0) {
    throw new Error(`${dieType.toUpperCase()} has invalid dimensions.`);
  }

  const sizeMultiplier = DIE_SIZE_MULTIPLIERS[dieType] ?? 1.0;
  const scale = (2.2 / maxDim) * sizeMultiplier;

  for (let i = 0; i < vertices.length; i += 3) {
    vertices[i] = (vertices[i] - center.x) * scale;
    vertices[i + 1] = (vertices[i + 1] - center.y) * scale;
    vertices[i + 2] = (vertices[i + 2] - center.z) * scale;
  }

  const stats = analyzeVertices(vertices);
  const visual = await loadGLTF(skin, dieType);
  visual.scale.setScalar(scale);
  visual.position.set(
    -center.x * scale,
    -center.y * scale,
    -center.z * scale
  );
  visual.updateMatrixWorld(true);

  // Preserve the current collider behavior exactly: D6 is cuboid, all other dice use convex hull.
  const colliderMode = dieType === 'd6' ? 'cuboid' : 'convexHull';

  const meta = {
    skin,
    dieType,
    colliderVertices: vertices,
    visualPrototype: visual,
    scale,
    originalSize: size,
    originalCenter: center,
    stats,
    colliderMode
  };

  dieMetaCache.set(cacheKey, meta);
  return meta;
}

function createColliderDesc(meta) {
  if (meta.colliderMode === 'cuboid') {
    const hx = Math.max(Math.abs(meta.stats.min.x), Math.abs(meta.stats.max.x));
    const hy = Math.max(Math.abs(meta.stats.min.y), Math.abs(meta.stats.max.y));
    const hz = Math.max(Math.abs(meta.stats.min.z), Math.abs(meta.stats.max.z));

    if (![hx, hy, hz].every(Number.isFinite) || Math.min(hx, hy, hz) <= 0) {
      throw new Error(`Invalid cuboid extents for ${meta.dieType.toUpperCase()}.`);
    }

    return R.ColliderDesc.cuboid(hx, hy, hz);
  }

  const desc = R.ColliderDesc.convexHull(meta.colliderVertices);
  if (!desc) {
    throw new Error(`Rapier could not create convex hull for ${meta.dieType.toUpperCase()}.`);
  }

  return desc;
}

function makeRollPose(seed, index, diceCount) {
  const rng = mulberry32(seed);

  // Keep the same throw model as the current single-die roller.
  // Only spread the individual dice starts around the table so multiple bodies
  // do not begin in exactly the same position.
  const placementRng = mulberry32(mixSeed(seed, index + 0x1000));

  const angle = (index / Math.max(1, diceCount)) * Math.PI * 2 + placementRng() * 0.7;
  const radius = diceCount <= 1 ? 0 : Math.min(4.2, 1.0 + Math.sqrt(diceCount) * 0.55) * (0.65 + placementRng() * 0.35);

  const basePosition = new THREE.Vector3(
    Math.cos(angle) * radius,
    2.3 + rng() * 1.2,
    Math.sin(angle) * radius
  );

  const orientation = randomQuaternion(rng);

  const horizontal = randomUnitVector(rng);
  horizontal.y = 0;
  if (horizontal.lengthSq() < 1e-8) horizontal.set(1, 0, 0);
  horizontal.normalize();

  const linearVelocity = horizontal.multiplyScalar(4 + rng() * 3.5);
  linearVelocity.y = 5.3 + rng() * 2.4;

  const angularVelocity = randomVector(rng, 10.5)
    .multiplyScalar(0.65 + rng() * 0.7);

  finiteVector(basePosition, 'pose.position');
  finiteQuaternion(orientation, 'pose.orientation');
  finiteVector(linearVelocity, 'pose.linearVelocity');
  finiteVector(angularVelocity, 'pose.angularVelocity');

  return {
    position: basePosition,
    orientation,
    linearVelocity,
    angularVelocity
  };
}

function createDieBody(world, meta, pose) {
  const bodyDesc = R.RigidBodyDesc.dynamic()
    .setTranslation(
      finiteNumber(pose.position.x, 'position.x'),
      finiteNumber(pose.position.y, 'position.y'),
      finiteNumber(pose.position.z, 'position.z')
    )
    .setRotation({
      x: finiteNumber(pose.orientation.x, 'orientation.x'),
      y: finiteNumber(pose.orientation.y, 'orientation.y'),
      z: finiteNumber(pose.orientation.z, 'orientation.z'),
      w: finiteNumber(pose.orientation.w, 'orientation.w')
    })
    .setCanSleep(true);

  const body = world.createRigidBody(bodyDesc);

  body.setLinvel({
    x: finiteNumber(pose.linearVelocity.x, 'linearVelocity.x'),
    y: finiteNumber(pose.linearVelocity.y, 'linearVelocity.y'),
    z: finiteNumber(pose.linearVelocity.z, 'linearVelocity.z')
  }, true);

  body.setAngvel({
    x: finiteNumber(pose.angularVelocity.x, 'angularVelocity.x'),
    y: finiteNumber(pose.angularVelocity.y, 'angularVelocity.y'),
    z: finiteNumber(pose.angularVelocity.z, 'angularVelocity.z')
  }, true);

  const colliderDesc = createColliderDesc(meta)
    .setFriction(0.62)
    .setRestitution(0.25)
    .setDensity(1.2);

  world.createCollider(colliderDesc, body);
  return body;
}

function readBodyState(body) {
  const p = body.translation();
  const r = body.rotation();
  const lv = body.linvel();
  const av = body.angvel();

  return {
    position: { x: Number(p.x), y: Number(p.y), z: Number(p.z) },
    rotation: { x: Number(r.x), y: Number(r.y), z: Number(r.z), w: Number(r.w) },
    linearVelocity: { x: Number(lv.x), y: Number(lv.y), z: Number(lv.z) },
    angularVelocity: { x: Number(av.x), y: Number(av.y), z: Number(av.z) }
  };
}

function findNonFiniteState(state) {
  for (const values of Object.values(state)) {
    for (const value of Object.values(values)) {
      if (!Number.isFinite(value)) return true;
    }
  }
  return false;
}

function velocityMagnitudes(state) {
  return {
    linear: Math.hypot(
      state.linearVelocity.x,
      state.linearVelocity.y,
      state.linearVelocity.z
    ),
    angular: Math.hypot(
      state.angularVelocity.x,
      state.angularVelocity.y,
      state.angularVelocity.z
    )
  };
}

function inspectFaces(dieType, rotation) {
  const map = faceMaps[dieType];
  if (!map) throw new Error(`No face map for ${dieType.toUpperCase()}.`);

  // D4 uses the bottom-facing (-Y) face as its displayed result.
  // All other dice use the top-facing (+Y) face.
  const resultDirection =
    dieType === 'd4'
      ? new THREE.Vector3(0, -1, 0)
      : UP;

  const result = [];

  for (const [numberString, face] of Object.entries(map)) {
    const normal = new THREE.Vector3(
      Number(face.normal[0]),
      Number(face.normal[1]),
      Number(face.normal[2])
    )
      .applyQuaternion(rotation)
      .normalize();

    result.push({
      number: Number(numberString),
      faceId: face.faceId,
      score: normal.dot(resultDirection)
    });
  }

  result.sort((a, b) => b.score - a.score);
  return result;
}

function clearVisible() {
  animation = null;
  rolling = false;
  visibleWorld = null;
  diceInstances = [];

  if (!scene) return;

  scene.traverse(() => {});

  const toRemove = [];
  scene.children.forEach((child) => {
    if (child.userData?.isDieVisual) toRemove.push(child);
  });

  for (const object of toRemove) {
    scene.remove(object);
    object.traverse((node) => {
      if (node.geometry) node.geometry.dispose?.();
      if (node.material) {
        if (Array.isArray(node.material)) {
          node.material.forEach((m) => m.dispose?.());
        } else {
          node.material.dispose?.();
        }
      }
    });
  }
}

function createVisibleRoll(world, meta, pose, dieType, id, seed, sign, keepCount, keepMode, termIndex) {
  const body = createDieBody(world, meta, pose);

  const visual = meta.visualPrototype.clone(true);
  visual.userData.isDieVisual = true;
  visual.userData.dieId = id;
  visual.traverse((node) => {
    if (node.isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });

  scene.add(visual);

  const die = {
    id,
    seed,
    dieType,
    sign,
    keepCount,
    keepMode,
    termIndex,
    body,
    visual,
    settledFrames: 0,
    settled: false,
    result: null,
    faceId: null
  };

  diceInstances.push(die);
  syncDieVisual(die);
  return die;
}

function finishRoll() {
  const breakdown = [];
  let total = animation.constantTotal;

  const termGroups = new Map();
  for (const die of diceInstances) {
    if (!termGroups.has(die.termIndex)) termGroups.set(die.termIndex, []);
    termGroups.get(die.termIndex).push(die);
  }

  for (const dice of termGroups.values()) {
    const keepCount = Math.min(dice[0]?.keepCount ?? dice.length, dice.length);
    const keepMode = dice[0]?.keepMode ?? 'all';
    const ranked = [...dice].sort((a, b) =>
      keepMode === 'lowest' ? a.result - b.result : b.result - a.result
    );

    for (let i = 0; i < ranked.length; i++) {
      ranked[i].kept = keepMode === 'all' || i < keepCount;
    }

    const kept = ranked.filter((die) => die.kept);
    const keptTotal = kept.reduce((sum, die) => sum + die.result, 0);
    total += (dice[0]?.sign ?? 1) * keptTotal;
  }

  const positiveGroups = new Map();
  const negativeGroups = new Map();
  for (const die of diceInstances) {
    const target = die.sign >= 0 ? positiveGroups : negativeGroups;
    if (!target.has(die.dieType)) target.set(die.dieType, []);
    target.get(die.dieType).push(die);
  }

  for (const [dieType, dice] of positiveGroups) {
    const values = dice.map((d) => d.kept === false ? `${d.result} (drop)` : String(d.result));
    const keep = dice[0]?.keepCount;
    const keepMode = dice[0]?.keepMode ?? 'all';
    const suffix = keep < dice.length
      ? ` keep ${keepMode === 'lowest' ? 'lowest ' : 'highest '}${keep}`
      : '';
    breakdown.push(`${dice.length}${dieType}${suffix}: [${values.join(', ')}]`);
  }
  for (const [dieType, dice] of negativeGroups) {
    const values = dice.map((d) => d.kept === false ? `${d.result} (drop)` : String(d.result));
    const keep = dice[0]?.keepCount;
    const keepMode = dice[0]?.keepMode ?? 'all';
    const suffix = keep < dice.length
      ? ` keep ${keepMode === 'lowest' ? 'lowest ' : 'highest '}${keep}`
      : '';
    breakdown.push(`-${dice.length}${dieType}${suffix}: [${values.join(', ')}]`);
  }
  if (animation.constantTerms.length) {
    breakdown.push(`Modifiers: ${animation.constantTerms.join(' ')}`);
  }

  els.resultBreakdown.textContent = breakdown.join('\n') || '—';
  els.result.textContent = String(total);
  setStatus(`Rolled ${diceInstances.length} dice → ${total}`);

  animation = null;
  rolling = false;
  els.rollButton.disabled = false;
}

function clearResult() {
  els.result.textContent = '—';
  els.resultBreakdown.textContent = '—';
}

function buildConstantTerms(terms) {
  return terms
    .filter((term) => term.type === 'constant')
    .map((term, i) => `${i === 0 && term.sign >= 0 ? '+' : term.sign < 0 ? '-' : '+'}${term.value}`);
}

async function handleRollManifest(manifest) {
  if (!manifest || manifest.type !== 'roll') return;

  // The server is authoritative for IDs, indexes, seeds, and parsed roll metadata.
  // The client only consumes that manifest and runs the existing physics pipeline.
  clearVisible();
  rolling = true;
  els.rollButton.disabled = true;
  if (els.overlay) els.overlay.classList.add('hidden');
  clearResult();

  try {
    const skin = manifest.skin || els.skinSelect.value;
    if (els.skinSelect.value !== skin) els.skinSelect.value = skin;

    if (!Array.isArray(manifest.dice) || manifest.dice.length === 0) {
      els.result.textContent = String(manifest.constantTotal ?? 0);
      els.resultBreakdown.textContent = manifest.expression || '—';
      setStatus(`No dice rolled → ${manifest.constantTotal ?? 0}`);
      rolling = false;
      els.rollButton.disabled = false;
      return;
    }

    setStatus(`Preparing ${manifest.dice.length} dice…`);

    visibleWorld = new R.World({ x: 0, y: -9.81, z: 0 });
    buildRapierArena(visibleWorld);

    const constantTerms = manifest.constantTerms || buildConstantTerms(manifest.terms || []);

    // Do not create animation until all initial dice bodies exist.
    // This preserves the working physics loop and prevents an empty dice array
    // from being mistaken for a completed roll.
    for (const die of manifest.dice) {
      const meta = await getDieMeta(skin, die.dieType);
      const pose = makeRollPose(die.seed, die.index, manifest.dice.length);

      createVisibleRoll(
        visibleWorld,
        meta,
        pose,
        die.dieType,
        die.id,
        die.seed,
        die.sign,
        die.keepCount,
        die.keepMode,
        die.termIndex
      );
    }

    animation = {
      accumulator: 0,
      constantTotal: Number(manifest.constantTotal || 0),
      constantTerms,
      rollSeed: manifest.rollSeed,
      rollId: manifest.rollId,
      expression: manifest.expression,
      diceCount: manifest.dice.length
    };

    rolling = true;
    els.rollButton.disabled = true;
    setStatus(`Rolling ${manifest.dice.length} dice…`);
  } catch (error) {
    console.error(error);
    setStatus('Roll failed');
    showError(error.message);
    clearVisible();
    els.rollButton.disabled = false;
    rolling = false;
  }
}

function sendRollRequest() {
  if (rolling) return;

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus('Server connection unavailable');
    showError('The dice server is not connected. Start the server and refresh the page.');
    return;
  }

  const expression = els.expressionInput.value;
  const skin = els.skinSelect.value;

  rolling = true;
  els.rollButton.disabled = true;
  clearVisible();
  clearResult();
  if (els.overlay) els.overlay.classList.add('hidden');
  setStatus('Requesting roll…');

  socket.send(JSON.stringify({
    type: 'roll',
    expression,
    skin
  }));
}

function reset() {
  clearVisible();
  clearResult();
  if (els.overlay) els.overlay.classList.add('hidden');
  els.rollButton.disabled = false;
  setStatus('Ready');
}

function connectSocket() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/ws`);

  socket.addEventListener('open', () => {
    setStatus('Connected — Ready');
    els.rollButton.disabled = false;
  });

  socket.addEventListener('message', async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      console.error('Invalid server message:', error);
      return;
    }

    if (message.type === 'connected') return;
    if (message.type === 'error') {
      rolling = false;
      els.rollButton.disabled = false;
      setStatus('Server error');
      showError(message.message || 'Server error.');
      return;
    }
    if (message.type === 'roll') {
      await handleRollManifest(message);
    }
  });

  socket.addEventListener('close', () => {
    if (!rolling) {
      setStatus('Disconnected from server');
      els.rollButton.disabled = true;
    }
    setTimeout(() => {
      if (!socket || socket.readyState === WebSocket.CLOSED) connectSocket();
    }, 1000);
  });

  socket.addEventListener('error', () => {
    if (!rolling) setStatus('Server connection error');
  });
}

async function init() {
  try {
    setStatus('Initializing…');
    await R.init();

    setStatus('Loading dice…');
    faceMaps = await loadFaceMaps();

    createRenderer();
    addTableVisual();

    await getDieMeta(els.skinSelect.value, 'd6');

    els.rollButton.disabled = true;
    connectSocket();
    setStatus('Connecting to dice server…');
  } catch (error) {
    console.error(error);
    setStatus('Initialization failed');
    showError(error.message);
  }
}

els.skinSelect.addEventListener('change', async () => {
  try {
    setStatus('Loading skin…');
    await getDieMeta(els.skinSelect.value, 'd6');
    if (socket?.readyState === WebSocket.OPEN && !rolling) setStatus('Ready');
  } catch (error) {
    console.error(error);
    setStatus('Error');
    showError(error.message);
  }
});

els.rollButton.addEventListener('click', sendRollRequest);
els.resetButton.addEventListener('click', reset);
els.expressionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !els.rollButton.disabled) {
    roll();
  }
});

init();
