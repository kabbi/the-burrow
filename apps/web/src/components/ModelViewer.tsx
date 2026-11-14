import { useEffect, useRef, useState } from "react";
import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * Shows a .glb or .stl you can spin. Loaded lazily (three.js is big).
 * `onPoster` gets a PNG of the first good frame: Burrow keeps it as the model's
 * picture, since the server has no GPU renderer.
 */
export default function ModelViewer({
  url,
  mime,
  height = 420,
  interactive = true,
  onPoster,
}: {
  url: string;
  mime: string;
  height?: number;
  interactive?: boolean;
  onPoster?: (png: Blob) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const posterCb = useRef(onPoster);
  useEffect(() => {
    posterCb.current = onPoster;
  }, [onPoster]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let stopped = false;
    const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new Scene();
    scene.add(new HemisphereLight(0xffffff, 0x8a8170, 2.2));
    const sun = new DirectionalLight(0xffffff, 2.4);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    const camera = new PerspectiveCamera(35, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enabled = interactive;
    controls.autoRotate = interactive;
    controls.autoRotateSpeed = 1.5;
    controls.addEventListener("start", () => (controls.autoRotate = false));

    const size = () => {
      const w = el.clientWidth || 300;
      const h = el.clientHeight || height;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    const fit = (obj: Object3D) => {
      const b = new Box3().setFromObject(obj);
      const c = b.getCenter(new Vector3());
      const s = b.getSize(new Vector3());
      obj.position.sub(c);
      const r = Math.max(s.x, s.y, s.z) || 1;
      const dist = (r / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.5;
      camera.position.set(dist * 0.6, dist * 0.45, dist * 0.8);
      camera.near = dist / 100;
      camera.far = dist * 100;
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
    };

    const load = async (): Promise<Object3D> => {
      if (mime === "model/stl" || url.endsWith(".stl")) {
        const geo = await new STLLoader().loadAsync(url);
        geo.computeVertexNormals();
        const mesh = new Mesh(
          geo,
          new MeshStandardMaterial({ color: new Color("#c9a66b"), roughness: 0.55, metalness: 0.1 }),
        );
        mesh.rotation.x = -Math.PI / 2; // STL files are usually Z-up
        return mesh;
      }
      return (await new GLTFLoader().loadAsync(url)).scene;
    };

    let frames = 0;
    let raf = 0;
    load()
      .then((obj) => {
        if (stopped) return;
        scene.add(obj);
        fit(obj);
        setLoading(false);
        const tick = () => {
          if (stopped) return;
          controls.update();
          renderer.render(scene, camera);
          // A few frames in, textures are up: take the poster.
          if (++frames === 6 && posterCb.current)
            renderer.domElement.toBlob((b) => b && posterCb.current?.(b), "image/png");
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch((e: Error) => {
        if (!stopped) {
          setError(e.message || "Couldn't open this model");
          setLoading(false);
        }
      });

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const x of mats) x.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url, mime, height, interactive]);

  return (
    <div ref={box} className="model-view" style={{ height }}>
      {loading && <span className="muted small model-note">Loading 3D model…</span>}
      {error && <span className="model-note error">{error}</span>}
    </div>
  );
}
