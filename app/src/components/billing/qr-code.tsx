import * as QRCode from "qrcode";
import * as React from "react";
import { useTranslation } from "react-i18next";

/** The QR code itself, rendered locally from the payload the order carries. */
export function QrCode({ payload }: { payload: string }) {
  const { t } = useTranslation("settings");
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setFailed(false);
    QRCode.toDataURL(payload, { margin: 1, width: 224 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  if (failed) {
    return (
      <p className="mt-4 text-muted-foreground text-sm">
        {t("subscribe.qrFailed")}
      </p>
    );
  }
  if (dataUrl === null) {
    // Same footprint as the code, so the layout does not jump when it arrives.
    return (
      <div className="mt-4 size-56 animate-pulse self-start rounded-lg border bg-muted" />
    );
  }
  return (
    <img
      src={dataUrl}
      alt={t("subscribe.qrAlt")}
      className="size-56 self-start rounded-lg border bg-white p-2"
      // The payload is the one thing on this page that must not lag its caption: rendering the
      // previous order's code under this order's countdown would invite paying a dead order.
      key={payload}
    />
  );
}
