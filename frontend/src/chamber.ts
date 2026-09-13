import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function createChamber(host: HTMLElement, onLoad: (fraction: number) => void) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0xeeeeE7, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D view of the actual agent-purchased GLB. Drag to orbit, scroll to zoom.');
  renderer.domElement.setAttribute('role', 'img');
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = !reduced;
  controls.autoRotateSpeed = 0.45;
  controls.enablePan = false;
  controls.minDistance = 4.6;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI / 2.05;
  const reset = () => { camera.position.set(5.6, 3.4, 6.3); controls.target.set(0, 1.15, 0); controls.update(); };
  reset();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  room.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x969e8d, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 3.5);
  sun.position.set(3, 7, 5); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5 });
  sun.shadow.normalBias = 0.04; scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.13 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.03; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(16, 48, 0xb2baac, 0xcdd1c6);
  grid.position.y = -0.04; (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.45; scene.add(grid);
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.4, 2.412, 96), new THREE.MeshBasicMaterial({ color: 0x96a48c, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = -0.02; scene.add(ring);
  const scanner = new THREE.Group();
  const scanPlane = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), new THREE.MeshBasicMaterial({ color: 0x8fab70, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
  scanPlane.rotation.x = -Math.PI / 2; scanner.add(scanPlane);
  const scanEdge = new THREE.LineSegments(new THREE.EdgesGeometry(scanPlane.geometry), new THREE.LineBasicMaterial({ color: 0x728d53, transparent: true, opacity: 0.7 }));
  scanEdge.rotation.x = -Math.PI / 2; scanner.add(scanEdge); scanner.visible = false; scene.add(scanner);
  const volume = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(3.6, 2.8, 3.6)), new THREE.LineBasicMaterial({ color: 0x87977b, transparent: true, opacity: 0.16 }));
  volume.position.y = 1.4; volume.visible = false; scene.add(volume);
  const cache = new Map<string, Promise<THREE.Group>>();
  let current: THREE.Group | undefined;
  let visible = true;
  let wire = false;
  let scanning = false;
  let desired = '';
  const loader = new GLTFLoader();
  async function load(url: string) {
    desired = url;
    if (!cache.has(url)) {
      cache.set(url, loader.loadAsync(url, event => onLoad(event.total ? Math.min(0.98, event.loaded / event.total) : 0)).then(gltf => {
        const object = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(object);
        const size = bounds.getSize(new THREE.Vector3());
        const scale = 3.6 / Math.max(size.x, size.y, size.z);
        object.scale.multiplyScalar(scale);
        const normalized = new THREE.Box3().setFromObject(object);
        const center = normalized.getCenter(new THREE.Vector3());
        object.position.sub(new THREE.Vector3(center.x, normalized.min.y, center.z));
        object.traverse(child => { if (child instanceof THREE.Mesh) { child.castShadow = true; child.receiveShadow = true; } });
        const group = new THREE.Group(); group.add(object); return group;
      }));
    }
    const group = await cache.get(url)!;
    if (desired !== url) return;
    if (current) scene.remove(current);
    current = group; scene.add(current); current.visible = visible;
    setWire(wire); onLoad(1); reset();
  }
  function setWire(value: boolean) {
    wire = value;
    current?.traverse(child => {
      if (child instanceof THREE.Mesh) for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if ('wireframe' in material) material.wireframe = wire;
      }
    });
  }
  const resize = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
  }); resize.observe(host);
  let previous = 0;
  renderer.setAnimationLoop(time => {
    const delta = Math.min((time - previous) / 1000, 0.1); previous = time;
    if (document.hidden) return;
    controls.update(delta);
    if (scanning) scanner.position.y = reduced ? 1.5 : 1.4 + Math.sin(time * 0.0018) * 1.35;
    renderer.render(scene, camera);
  });
  return { load, reset, setWire,
    setState(show: boolean, scan: boolean) {
      visible = show; scanning = scan;
      if (current) current.visible = show;
      scanner.visible = scan; volume.visible = scan;
    },
    setRotate(value: boolean) { controls.autoRotate = value && !reduced; },
  };
}
