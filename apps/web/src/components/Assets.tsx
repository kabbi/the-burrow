import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  del,
  get,
  patch,
  post,
  upload,
  type AssetRole,
  type AssetsReply,
  type AssetView,
} from "../lib/api.ts";
import { useAction, useDebounced, useRefresh } from "../lib/hooks.ts";
import { useToast } from "../lib/toast.tsx";

const ModelViewer = lazy(() => import("./ModelViewer.tsx"));

export const ROLE_LABEL: Record<AssetRole, string> = {
  photo: "Our photo",
  product: "Shop photo",
  icon: "Icon",
  sprite: "2D art",
  model: "3D model",
  other: "Other",
};
const PICTURE_ROLES: AssetRole[] = ["photo", "product", "sprite", "icon", "other"];

interface AssetConfig {
  roles: AssetRole[];
  sf3d: { ok: boolean; device?: string; busy: boolean };
}

/**
 * Every picture and model of a thing (D-015): our photos, shop photos, icons,
 * 2D art, 3D models. One of them is the cover the rest of Burrow shows.
 */
export function Assets({
  thingId,
  thingName,
  assets,
  coverId,
  shownId,
}: {
  thingId: string;
  thingName: string;
  assets: AssetView[];
  coverId: string | null;
  /** The cover actually shown (chosen or automatic). */
  shownId: string | null;
}) {
  const act = useAction();
  const toast = useToast();
  const refresh = useRefresh();
  const [open, setOpen] = useState<AssetView | null>(null);
  const [adding, setAdding] = useState<null | "link" | "icon">(null);
  const [role, setRole] = useState<AssetRole>("photo");
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const { data: cfg } = useQuery({
    queryKey: ["asset-config"],
    queryFn: () => get<AssetConfig>("/assets/config"),
    staleTime: 30_000,
  });

  const send = async (files: File[], as: AssetRole = role) => {
    for (const f of files) {
      setBusy(`Uploading ${f.name}…`);
      await act(
        () => upload(`/things/${thingId}/assets`, f, { role: as, filename: f.name }),
        (r) => `Added ${ROLE_LABEL[r.asset?.role ?? as].toLowerCase()}`,
      );
    }
    setBusy(null);
  };

  // The photo SF3D works from: the shown cover if it's a photo, else the first photo-ish asset.
  const source =
    assets.find((a) => a.id === shownId && isPhoto(a)) ??
    assets.find((a) => a.role === "photo" && isPhoto(a)) ??
    assets.find(isPhoto);
  const makeModel = async () => {
    if (!source) return;
    setBusy("Making a 3D model with Stable Fast 3D… (usually 10–30 s)");
    await act(
      () => post<AssetsReply>(`/things/${thingId}/assets/generate-model`, { fromAssetId: source.id }),
      "3D model made — check it, it's a guess",
    );
    setBusy(null);
  };

  // Models without a picture get one rendered here, one at a time.
  const needsPoster = assets.find((a) => a.role === "model" && !a.thumb);

  return (
    <section
      className={`panel stack${drag ? " dropping" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void send([...e.dataTransfer.files]);
      }}
    >
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="eyebrow">Pictures & models · {assets.length}</h2>
        {coverId && (
          <button
            type="button"
            className="btn small ghost"
            onClick={() =>
              act(() => post(`/things/${thingId}/cover`, { assetId: null }), "Cover picked automatically")
            }
          >
            Pick cover automatically
          </button>
        )}
      </div>

      {assets.length > 0 ? (
        <div className="assets">
          {assets.map((a) => (
            <figure key={a.id} className={`asset${a.id === shownId ? " shown" : ""}`}>
              <button
                type="button"
                className="asset-pic"
                onClick={() => setOpen(a)}
                aria-label={`Open ${ROLE_LABEL[a.role]}`}
              >
                {a.thumbUrl ? (
                  <img
                    src={a.thumbUrl}
                    alt=""
                    loading="lazy"
                    className={a.role === "icon" || a.role === "sprite" ? "contain" : ""}
                  />
                ) : (
                  <span className="asset-ph">{a.role === "model" ? "3D" : "?"}</span>
                )}
                {a.role === "model" && <span className="badge3d">3D</span>}
              </button>
              <figcaption className="stack" style={{ gap: 4 }}>
                <span className="row" style={{ gap: 4, justifyContent: "space-between" }}>
                  <select
                    className="input mini"
                    value={a.role}
                    aria-label="What is this"
                    onChange={(e) => act(() => patch(`/assets/${a.id}`, { role: e.target.value }), "Changed")}
                  >
                    {(a.role === "model" ? (["model"] as AssetRole[]) : PICTURE_ROLES).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="tagx"
                    aria-label="Remove"
                    title="Remove"
                    onClick={() => act(() => del(`/assets/${a.id}`), `${ROLE_LABEL[a.role]} removed`)}
                  >
                    ×
                  </button>
                </span>
                {a.id === shownId ? (
                  <span className="small shown-note">
                    {a.id === coverId ? "★ Cover" : "Cover (automatic)"}
                  </span>
                ) : a.thumbUrl ? (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() =>
                      act(() => post(`/things/${thingId}/cover`, { assetId: a.id }), "Cover changed")
                    }
                  >
                    Use as cover
                  </button>
                ) : (
                  <span className="small muted">no picture yet</span>
                )}
                {typeof a.data.view === "string" && (
                  <span className="small muted">
                    {a.data.view} side{a.originalUrl ? " · original kept" : ""}
                  </span>
                )}
                {a.source === "ai" && (
                  <span className="small ai-note">made by {String(a.data.generator ?? "AI")}</span>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          No pictures yet. Add a photo, a shop picture, an icon or a 3D model — or drop files here.
        </p>
      )}

      <div className="row">
        <label className="btn main">
          Take photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              void send([...(e.target.files ?? [])], "photo");
              e.target.value = "";
            }}
          />
        </label>
        <label className="btn">
          Upload…
          <input
            type="file"
            multiple
            accept="image/*,.glb,.stl"
            hidden
            onChange={(e) => {
              void send([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </label>
        <select
          className="input"
          style={{ width: "auto", minHeight: 36 }}
          value={role}
          onChange={(e) => setRole(e.target.value as AssetRole)}
          aria-label="Upload as"
          title="What uploaded pictures are (3D files are always models)"
        >
          {PICTURE_ROLES.filter((r) => r !== "icon").map((r) => (
            <option key={r} value={r}>
              as {ROLE_LABEL[r].toLowerCase()}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          aria-pressed={adding === "link"}
          onClick={() => setAdding(adding === "link" ? null : "link")}
        >
          From a link
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={adding === "icon"}
          onClick={() => setAdding(adding === "icon" ? null : "icon")}
        >
          Pick an icon
        </button>
        {cfg?.sf3d.ok && source && (
          <button
            type="button"
            className="btn"
            disabled={Boolean(busy)}
            title={`Stable Fast 3D on the local GPU (${cfg.sf3d.device ?? "?"}), free`}
            onClick={() => void makeModel()}
          >
            Make 3D model
          </button>
        )}
      </div>
      {busy && (
        <p className="small muted" style={{ margin: 0 }}>
          {busy}
        </p>
      )}

      {adding === "link" && (
        <LinkAdder
          onAdd={async (url) => {
            setBusy("Downloading…");
            const r = await act(
              () =>
                post<AssetsReply>(`/things/${thingId}/assets/from-url`, {
                  url,
                  role: role === "photo" ? "product" : role,
                }),
              "Picture saved",
            );
            setBusy(null);
            if (r) setAdding(null);
          }}
        />
      )}
      {adding === "icon" && (
        <IconPicker
          initial={thingName}
          onPick={async (set, name) => {
            const r = await act(
              () => post(`/things/${thingId}/assets/icon`, { set, name }),
              `Icon ${name} added`,
            );
            if (r) setAdding(null);
          }}
        />
      )}

      {needsPoster && (
        <div className="offscreen" aria-hidden="true">
          <Suspense fallback={null}>
            <ModelViewer
              key={needsPoster.id}
              url={needsPoster.fileUrl}
              mime={needsPoster.mime}
              height={480}
              interactive={false}
              onPoster={(png) =>
                void upload(`/assets/${needsPoster.id}/thumb`, png, { auto: "1" })
                  .then(() => refresh())
                  .catch((e: Error) => toast({ text: `No picture for the model: ${e.message}`, error: true }))
              }
            />
          </Suspense>
        </div>
      )}

      {open && <Lightbox asset={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

const isPhoto = (a: AssetView) => a.mime.startsWith("image/") && a.mime !== "image/svg+xml";

function LinkAdder({ onAdd }: { onAdd: (url: string) => Promise<void> }) {
  const [url, setUrl] = useState("");
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^https?:\/\//.test(url.trim())) void onAdd(url.trim());
      }}
    >
      <input
        className="input grow"
        autoFocus
        placeholder="https://… a picture or a .glb / .stl file"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-label="Picture link"
      />
      <button type="submit" className="btn small main">
        Save
      </button>
    </form>
  );
}

/** Search the bundled open-source icon sets (Tabler, Lucide). Nothing leaves the server. */
function IconPicker({ initial, onPick }: { initial: string; onPick: (set: string, name: string) => void }) {
  const [q, setQ] = useState(initial);
  const dq = useDebounced(q, 200);
  const { data } = useQuery({
    queryKey: ["icons", dq],
    queryFn: () =>
      get<{ icons: { set: string; name: string }[] }>(`/icons?q=${encodeURIComponent(dq)}&limit=80`),
  });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <input
        className="input"
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="drill, plug, box…"
        aria-label="Search icons"
      />
      <div className="icon-grid">
        {data?.icons.map((i) => (
          <button
            type="button"
            key={`${i.set}:${i.name}`}
            className="icon-pick"
            title={`${i.name} (${i.set})`}
            onClick={() => onPick(i.set, i.name)}
          >
            <img src={`/api/icons/${i.set}/${i.name}.svg`} alt={i.name} loading="lazy" />
          </button>
        ))}
        {data && !data.icons.length && (
          <span className="muted small">No icons match — try a simpler word.</span>
        )}
      </div>
      <span className="muted small">Icons: Tabler (MIT) and Lucide (ISC).</span>
    </div>
  );
}

function Lightbox({ asset, onClose }: { asset: AssetView; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const facts = [
    ROLE_LABEL[asset.role],
    asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
    `${(asset.bytes / 1024 / 1024).toFixed(asset.bytes > 1e6 ? 1 : 2)} MB`,
    asset.source !== "you" ? `from ${asset.source}` : null,
    typeof asset.data.license === "string"
      ? `${String(asset.data.setName ?? "")} · ${asset.data.license}`
      : null,
  ].filter(Boolean);
  return (
    <dialog
      ref={ref}
      className="lightbox"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="stack" style={{ gap: 10 }}>
        {asset.role === "model" ? (
          <Suspense fallback={<div className="model-view" style={{ height: 520 }} />}>
            <ModelViewer
              url={asset.fileUrl}
              mime={asset.mime}
              height={Math.min(520, Math.round(window.innerHeight * 0.65))}
            />
          </Suspense>
        ) : (
          <img src={asset.fileUrl} alt="" className={asset.role === "icon" ? "contain" : ""} />
        )}
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted small">{facts.join(" · ")}</span>
          <span className="row">
            {typeof asset.data.url === "string" && (
              <a className="btn small" href={asset.data.url} target="_blank" rel="noreferrer">
                Source
              </a>
            )}
            <a className="btn small" href={asset.fileUrl} download>
              Download
            </a>
            {asset.originalUrl && (
              <a className="btn small" href={asset.originalUrl} download>
                Original
              </a>
            )}
            <button type="button" className="btn small" onClick={onClose}>
              Close
            </button>
          </span>
        </div>
      </div>
    </dialog>
  );
}
