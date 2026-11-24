import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { App } from "./App";

type Mode =
  | { kind: "loading" }
  | { kind: "local" }
  | { kind: "cloud"; origin: string | null; error?: string };

export function DesktopSetup() {
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    invoke<string | null>("saved_cloud_origin").then(
      (origin) => {
        if (active)
          setMode(origin ? { kind: "cloud", origin } : { kind: "local" });
      },
      () => {
        if (active)
          setMode({
            kind: "cloud",
            origin: null,
            error:
              "OpenBot couldn’t read the saved cloud address. Enter it again or forget it to return to setup.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  switch (mode.kind) {
    case "loading":
      return (
        <main>
          <section className="sheet">
            <h1>Getting OpenBot ready</h1>
            <p className="lede" role="status">
              Checking your saved connection…
            </p>
          </section>
        </main>
      );
    case "local":
      return <App onCloud={() => setMode({ kind: "cloud", origin: null })} />;
    case "cloud":
      return (
        <CloudConnection
          origin={mode.origin}
          savedError={mode.error}
          onLocal={() => setMode({ kind: "local" })}
          onSaved={(origin) => setMode({ kind: "cloud", origin })}
        />
      );
  }
}

function CloudConnection({
  origin,
  savedError,
  onLocal,
  onSaved,
}: {
  origin: string | null;
  savedError?: string;
  onLocal: () => void;
  onSaved: (origin: string) => void;
}) {
  const [address, setAddress] = useState(origin ?? "");
  const [editing, setEditing] = useState(!origin);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(
        typeof failure === "string"
          ? failure
          : "OpenBot couldn’t complete the request. Try again.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const connect = () =>
    run(async () => {
      const saved = await invoke<string>("open_cloud", {
        origin: editing ? address : origin,
      });
      setAddress(saved);
      setEditing(false);
      onSaved(saved);
    });

  const disconnect = () =>
    run(async () => {
      await invoke("disconnect_cloud");
      onLocal();
    });

  return (
    <main>
      <section className="sheet connection-sheet" aria-labelledby="cloud-title">
        <VStack gap={4}>
          <h1 id="cloud-title">OpenBot Cloud</h1>
          {editing ? (
            <p className="lede">
              Enter the HTTPS address provided by your organization. Sign in
              using your organization’s sign-in page.
            </p>
          ) : (
            <>
              <p className="lede">
                Saved address <strong>{origin}</strong>
              </p>
              <p className="lede">
                Open the cloud window to sign in. If the page fails to load,
                open it again to retry.
              </p>
            </>
          )}
          {editing && (
            <TextInput
              type="url"
              label="OpenBot Cloud address"
              placeholder="https://openbot.example.com"
              value={address}
              onChange={setAddress}
              onEnter={() => {
                if (address.trim()) void connect();
              }}
              isDisabled={pending}
              width="100%"
            />
          )}
          {(error ?? savedError) && <p role="alert">{error ?? savedError}</p>}
          <HStack gap={2} wrap="wrap">
            <Button
              label={editing ? "Connect and sign in" : "Open cloud window"}
              variant="primary"
              isDisabled={pending || (editing && !address.trim())}
              onClick={() => void connect()}
            />
            {origin && (
              <Button
                label={editing ? "Cancel" : "Change address"}
                isDisabled={pending}
                onClick={() => {
                  setAddress(origin);
                  setError(undefined);
                  setEditing(!editing);
                }}
              />
            )}
            {origin || savedError ? (
              <Button
                label={origin ? "Disconnect" : "Forget saved address"}
                isDisabled={pending}
                onClick={() => void disconnect()}
              />
            ) : (
              <Button
                label="Back to setup"
                isDisabled={pending}
                onClick={onLocal}
              />
            )}
          </HStack>
          {pending && <p role="status">Working…</p>}
        </VStack>
      </section>
    </main>
  );
}
