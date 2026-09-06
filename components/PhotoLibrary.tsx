"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Icon from "./WorkbenchIcon";
import { mediaStage } from "@/lib/media-stage";
import type { InventoryItem } from "@/lib/supabase";
import type { ResaleMedia } from "@/lib/resale-contract";
import {
  createMediaUploadIntent,
  uploadOriginal,
  loadOriginalPreview,
  type MediaUploadIntent,
} from "@/lib/resale-media";

export type MediaClient = {
  createMediaUploadIntent: typeof createMediaUploadIntent;
  uploadOriginal: typeof uploadOriginal;
  loadOriginalPreview: typeof loadOriginalPreview;
};
const client: MediaClient = {
  createMediaUploadIntent,
  uploadOriginal,
  loadOriginalPreview,
};
type Upload = {
  intent: MediaUploadIntent;
  state: "waiting" | "uploading" | "ready" | "error";
  error?: string;
};
function OriginalPreview({
  media,
  name,
  api,
}: {
  media: ResaleMedia;
  name: string;
  api: MediaClient;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const resource = useRef<{ url: string; revoke: () => void } | null>(null),
    controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      resource.current?.revoke();
    },
    [],
  );
  async function load() {
    if (busy) return;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const preview = await api.loadOriginalPreview(media.id, abort.signal);
      if (abort.signal.aborted) {
        preview.revoke();
        return;
      }
      resource.current?.revoke();
      resource.current = preview;
      setUrl(preview.url);
    } catch {
      if (!abort.signal.aborted)
        setError("Could not open this photo. Try again.");
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="wb-photo-preview">
      {url ? (
        <Image
          src={url}
          unoptimized
          width={500}
          height={600}
          alt={`Original photo of ${name}`}
        />
      ) : (
        <div>
          <Icon name="photo" size={35} />
          <button
            className="wb-button wb-button-secondary"
            onClick={load}
            disabled={busy || media.state !== "ready"}
          >
            {busy
              ? "Opening…"
              : media.state === "ready"
                ? "View original"
                : media.state === "pending"
                  ? "Upload pending"
                  : media.state === "quarantined"
                    ? "Photo unavailable"
                    : "Upload failed"}
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
export default function PhotoLibrary({
  inventory,
  media,
  selectedId,
  onSelect,
  onSaved,
  api = client,
  connected = !!process.env.NEXT_PUBLIC_RESALE_MEDIA_URL,
}: {
  inventory: InventoryItem[];
  media: ResaleMedia[];
  selectedId: string;
  onSelect: (id: string) => void;
  onSaved: () => Promise<void>;
  api?: MediaClient;
  connected?: boolean;
}) {
  const [uploads, setUploads] = useState<Upload[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [limit, setLimit] = useState(12);
  const queue = useRef<Upload[]>([]),
    lock = useRef(false),
    abort = useRef<AbortController | null>(null),
    mounted = useRef(true);
  const retryRow = useRef<ResaleMedia | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const preview = process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview";
  const originals = media
    .filter(
      (photo) =>
        photo.kind === "original" &&
        (!selectedId || photo.inventory_id === selectedId),
    )
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const unresolved = uploads.some((upload) => upload.state !== "ready");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!unresolved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unresolved]);
  function update(id: string, values: Partial<Upload>) {
    queue.current = queue.current.map((upload) =>
      upload.intent.requestId === id ? { ...upload, ...values } : upload,
    );
    if (mounted.current) setUploads([...queue.current]);
  }
  async function processQueue() {
    if (lock.current || preview) return;
    lock.current = true;
    setBusy(true);
    setError("");
    abort.current = new AbortController();
    try {
      for (const upload of queue.current) {
        if (upload.state === "ready") continue;
        update(upload.intent.requestId, {
          state: "uploading",
          error: undefined,
        });
        try {
          await api.uploadOriginal(upload.intent, abort.current.signal);
          update(upload.intent.requestId, { state: "ready" });
        } catch (failure) {
          if (mounted.current)
            update(upload.intent.requestId, {
              state: "error",
              error:
                failure instanceof Error
                  ? failure.message
                  : "Upload was not confirmed. Retry this original.",
            });
          break;
        }
      }
      if (mounted.current) {
        try {
          await mediaStage("Refreshing the photo library", abort.current.signal, () => onSaved());
        } catch {
          if (mounted.current) setError("The photo list could not refresh. Saved uploads stay saved. Retry unconfirmed uploads, or use Refresh records to check the list.");
        }
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function choose(files: FileList | null) {
    if (!files?.length || busy) return;
    setError("");
    try {
      const entries = Array.from(files).map((file) => {
        const existing = retryRow.current;
        if (
          existing &&
          (file.type !== existing.mime_type || file.size !== existing.byte_size)
        )
          throw new Error(
            "Choose the same original: its file type and size must match the pending upload.",
          );
        const intent = api.createMediaUploadIntent(
          existing?.inventory_id || selectedId,
          file,
        );
        if (!intent.inventoryId)
          throw new Error("Choose an inventory item before adding photos.");
        if (existing) intent.requestId = existing.id;
        return { intent, state: "waiting" as const };
      });
      queue.current = [
        ...queue.current.filter(
          (entry) =>
            !entries.some(
              (next) => next.intent.requestId === entry.intent.requestId,
            ),
        ),
        ...entries,
      ];
      setUploads([...queue.current]);
      retryRow.current = null;
      void processQueue();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not prepare these photos.",
      );
    }
    if (fileInput.current) fileInput.current.value = "";
  }
  return (
    <div className="wb-photo-library">
      <section className="wb-panel">
        <div className="wb-section-heading">
          <div>
            <p className="wb-eyebrow">ORIGINALS, KEPT TOGETHER</p>
            <h2>
              Your photo library{" "}
              <span className="wb-count">{originals.length}</span>
            </h2>
            <p>
              Private originals · choose a photo to open its full resolution
            </p>
          </div>
          <Icon name="photo" size={24} />
        </div>
        <div className="wb-photo-toolbar">
          <label className="wb-field">
            Inventory item
            <select
              value={selectedId}
              onChange={(event) => {
                onSelect(event.target.value);
                setLimit(12);
              }}
              disabled={busy}
            >
              <option value="">All items</option>
              {inventory.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.item_name}
                </option>
              ))}
            </select>
          </label>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple={!retryRow.current}
            className="wb-sr-only"
            tabIndex={-1}
            aria-label="Original photo files"
            onChange={(event) => choose(event.target.files)}
            disabled={busy || preview || !connected}
          />
          <button
            className="wb-button wb-button-primary"
            disabled={!selectedId || busy || preview || !connected}
            onClick={() => {
              retryRow.current = null;
              if (fileInput.current) {
                fileInput.current.multiple = true;
                fileInput.current.click();
              }
            }}
          >
            <Icon name="plus" size={17} />
            Add original photos
          </button>
        </div>
        <p className="wb-photo-support">
          JPEG, PNG, WebP, or GIF · up to 20 MiB each. HEIC and RAW originals
          need a separate preservation workflow.
        </p>
        {!connected && (
          <div className="wb-note">
            <Icon name="attention" size={20} />
            <p>
              Photo storage is not connected in this environment. Your records
              are available; uploading and viewing originals will be available
              after setup.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="wb-alert">
            {error}
          </p>
        )}
        {!!uploads.length && (
          <section className="wb-upload-status" aria-label="Photo uploads">
            <h3>
              {busy
                ? "Saving your originals…"
                : unresolved
                  ? "Some uploads need a retry"
                  : "Originals saved"}
            </h3>
            <ul>
              {uploads.map((upload) => (
                <li key={upload.intent.requestId}>
                  <span>{upload.intent.file.name}</span>
                  <strong>
                    {upload.state === "ready"
                      ? "Saved & linked"
                      : upload.state === "error"
                        ? "Not confirmed"
                        : upload.state === "uploading"
                          ? "Uploading…"
                          : "Waiting"}
                  </strong>
                  {upload.error && <p role="alert">{upload.error}</p>}
                </li>
              ))}
            </ul>
            {unresolved && (
              <>
                <p>
                  Keep this tab open. Retrying uses the same original and upload
                  ID.
                </p>
                <button
                  className="wb-button wb-button-secondary"
                  disabled={busy || preview}
                  onClick={processQueue}
                >
                  Retry unconfirmed uploads
                </button>
              </>
            )}
          </section>
        )}
        {originals.length ? (
          <>
            <div className="wb-photo-grid">
              {originals.slice(0, limit).map((photo) => (
                <article className="wb-photo-card" key={photo.id}>
                  <OriginalPreview
                    media={photo}
                    name={
                      inventory.find((item) => item.id === photo.inventory_id)
                        ?.item_name || "saved inventory item"
                    }
                    api={api}
                  />
                  <div>
                    <h3>
                      {inventory.find((item) => item.id === photo.inventory_id)
                        ?.item_name || "Saved inventory item"}
                    </h3>
                    <p>
                      Original ·{" "}
                      {photo.byte_size == null
                        ? "Size unknown"
                        : `${(photo.byte_size / 1048576).toFixed(1)} MiB`}
                    </p>
                    <span
                      className={`wb-badge ${photo.state === "ready" ? "wb-badge-green" : "wb-badge-amber"}`}
                    >
                      {photo.state === "ready" ? "Saved & linked" : photo.state}
                    </span>
                    {photo.state === "pending" &&
                      !queue.current.some(
                        (upload) => upload.intent.requestId === photo.id,
                      ) && (
                        <button
                          className="wb-text-button"
                          disabled={busy || preview || !connected}
                          onClick={() => {
                            retryRow.current = photo;
                            if (fileInput.current) {
                              fileInput.current.multiple = false;
                              fileInput.current.click();
                            }
                          }}
                        >
                          Retry with same original
                        </button>
                      )}
                  </div>
                </article>
              ))}
            </div>
            {originals.length > limit && (
              <div className="wb-load-more">
                <button
                  className="wb-button wb-button-secondary"
                  onClick={() => setLimit(limit + 12)}
                >
                  Show more photos
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="wb-empty">
            <span className="wb-empty-icon">
              <Icon name="photo" size={35} />
            </span>
            <h3>
              {selectedId
                ? "Every angle starts here."
                : "A home for your original photos."}
            </h3>
            <p>
              {selectedId
                ? "Add the full view, labels, and details. Each original stays linked to this item."
                : "Choose a saved inventory item above to add its photos."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
