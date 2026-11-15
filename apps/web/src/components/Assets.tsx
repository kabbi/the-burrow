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
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const { data: cfg } = useQuery({
    queryKey: ["asset-config"],
    queryFn: () => get<AssetConfig>("/assets/config"),
    staleTime: 30_000,
  });

  const send = async (files: File[], as: AssetRole = "photo") => {
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
      id="pictures"
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
      <h2 className="eyebrow">Pictures & models · {assets.length}</h2>

      {assets.length > 0 ? (
        <div className="assets">
          {assets.map((a) => (
            <figure key={a.id} className={`asset${a.id === shownId ? " shown" : ""}`}>
              <button
                type="button"
                className="asset-pic"
                onClick={() => setOpen(a)}
                aria-label={`Open ${ROLE_LABEL[a.role]}`}
                title={`${ROLE_LABEL[a.role]}${a.id === shownId ? (a.id === coverId ? " · cover" : " · cover (automatic)") : ""}${typeof a.data.view === "string" ? ` · ${a.data.view} side` : ""}`}
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
                {a.source === "ai" && <span className="badgeai">AI</span>}
              </button>
              {a.id === shownId ? (
                <span
                  className="asset-star on"
                  title={a.id === coverId ? "Cover" : "Cover (picked automatically)"}
                >
                  ★
                </span>
              ) : (
                a.thumbUrl && (
                  <button
                    type="button"
                    className="asset-star"
                    title="Use as cover"
                    aria-label="Use as cover"
                    onClick={() =>
                      act(() => post(`/things/${thingId}/cover`, { assetId: a.id }), "Cover changed")
                    }
                  >
                    ☆
                  </button>
                )
              )}
            </figure>
          ))}
        </div>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          No pictures yet. Take a photo, add a shop picture or an icon — or drop files here.
        </p>
      )}

      <div className="row" style={{ gap: 6 }}>
        <label className="btn small main">
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
        <label
          className="btn small"
          title="Pictures come in as our photos (change it on the picture); .glb / .stl are 3D models"
        >
          Upload
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
        <button
          type="button"
          className="btn small"
          aria-pressed={adding === "link"}
          onClick={() => setAdding(adding === "link" ? null : "link")}
        >
          Link
        </button>
        <button
          type="button"
          className="btn small"
          aria-pressed={adding === "icon"}
          onClick={() => setAdding(adding === "icon" ? null : "icon")}
        >
          Icon
        </button>
        {cfg?.sf3d.ok && source && (
          <button
            type="button"
            className="btn small"
            disabled={Boolean(busy)}
            title={`Make a 3D model with Stable Fast 3D on the local GPU (${cfg.sf3d.device ?? "?"}), free`}
            onClick={() => void makeModel()}
          >
            3D model
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
                  role: "product",
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

      {open && (
        <Lightbox
          key={open.id}
          asset={assets.find((a) => a.id === open.id) ?? open}
          thingId={thingId}
          isShown={open.id === shownId}
          isChosen={open.id === coverId}
          onClose={() => setOpen(null)}
        />
      )}
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

/** Search the bundled icon set (Material Design Icons). Nothing leaves the server. */
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
        placeholder="hammer, plug, box…"
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
      <span className="muted small">Icons: Material Design Icons (Apache-2.0).</span>
    </div>
  );
}

function Lightbox({
  asset,
  thingId,
  isShown,
  isChosen,
  onClose,
}: {
  asset: AssetView;
  thingId: string;
  /** It is the cover shown now; `isChosen`: picked by hand (else automatic). */
  isShown: boolean;
  isChosen: boolean;
  onClose: () => void;
}) {
  const act = useAction();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const facts = [
    ROLE_LABEL[asset.role],
    asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
    `${(asset.bytes / 1024 / 1024).toFixed(asset.bytes > 1e6 ? 1 : 2)} MB`,
    typeof asset.data.view === "string" ? `${asset.data.view} side` : null,
    asset.source === "ai"
      ? `made by ${String(asset.data.generator ?? "AI")}`
      : asset.source !== "you"
        ? `from ${asset.source}`
        : null,
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
          <span className="row" style={{ gap: 6 }}>
            <select
              className="input mini"
              style={{ flex: "none" }}
              value={asset.role}
              aria-label="What is this"
              onChange={(e) => act(() => patch(`/assets/${asset.id}`, { role: e.target.value }), "Changed")}
            >
              {(asset.role === "model" ? (["model"] as AssetRole[]) : PICTURE_ROLES).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            {isShown ? (
              isChosen ? (
                <button
                  type="button"
                  className="btn small"
                  title="Let Burrow pick the cover (our photo first)"
                  onClick={() =>
                    act(
                      () => post(`/things/${thingId}/cover`, { assetId: null }),
                      "Cover picked automatically",
                    )
                  }
                >
                  ★ Cover · pick automatically
                </button>
              ) : (
                <span className="small muted">★ Cover (automatic)</span>
              )
            ) : (
              asset.thumbUrl && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    act(() => post(`/things/${thingId}/cover`, { assetId: asset.id }), "Cover changed")
                  }
                >
                  Use as cover
                </button>
              )
            )}
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                onClose();
                void act(() => del(`/assets/${asset.id}`), `${ROLE_LABEL[asset.role]} removed`);
              }}
            >
              Remove
            </button>
          </span>
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
