import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { signInWithEmail, signOut, signUpWithEmail } from "./auth";
import { Button, Card, colors, ErrorNotice, Field, Mascot, s } from "../ui";

/**
 * 邮箱密码登录/注册表单。
 *
 * 校验规则（提交前，逐字段即时反馈）：
 * - 邮箱：非空 + 基本格式（user@domain.tld）；
 * - 密码：非空 + ≥8 位（与 server 的 minPasswordLength 一致）；
 * - 注册模式额外要求昵称非空。
 *
 * 失败分层：本地校验错误不发请求；服务端错误按 code 映射为友好文案
 * （凭据错误 / 功能未开放 / SSO 强制 / 已注册等），未知错误透传截断。
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(value: string): string | null {
  if (!value.trim()) return "请输入邮箱地址。";
  if (!EMAIL_RE.test(value.trim())) return "邮箱格式不正确，应为 user@example.com。";
  return null;
}

export function validatePassword(value: string): string | null {
  if (!value) return "请输入密码。";
  if (value.length < 8) return "密码至少 8 位。";
  return null;
}

export function validateName(value: string): string | null {
  if (!value.trim()) return "请输入昵称。";
  return null;
}

export function EmailSignInForm({
  onSignedIn,
}: {
  /** 登录（或注册后自动登录）成功；父层据此继续加载工作区。 */
  onSignedIn: () => void;
}) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; name?: string }>({});
  const [serverError, setServerError] = useState("");
  const [busy, setBusy] = useState(false);

  function validateAll(): boolean {
    const errors: typeof fieldErrors = {};
    const emailError = validateEmail(email);
    const passwordError = validatePassword(password);
    if (emailError) errors.email = emailError;
    if (passwordError) errors.password = passwordError;
    if (mode === "signup") {
      const nameError = validateName(name);
      if (nameError) errors.name = nameError;
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function submit() {
    setServerError("");
    if (!validateAll()) return;
    setBusy(true);
    try {
      if (mode === "signin") {
        const result = await signInWithEmail(email.trim(), password);
        if (!result.ok) {
          setServerError(result.reason);
          return;
        }
      } else {
        const created = await signUpWithEmail(email.trim(), password, name.trim());
        if (!created.ok) {
          setServerError(created.reason);
          return;
        }
        // 注册即登录（Better Auth sign-up 默认建立会话）。
        const signed = await signInWithEmail(email.trim(), password);
        if (!signed.ok) {
          setServerError(signed.reason);
          return;
        }
      }
      onSignedIn();
    } catch (e) {
      setServerError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ width: "100%", gap: 12 }}>
      {busy ? (
        <View style={{ alignItems: "center", paddingVertical: 8 }}>
          <ActivityIndicator color={colors.blueDark} />
          <Text style={[s.small, { marginTop: 8 }]}>
            {mode === "signin" ? "正在登录…" : "正在注册…"}
          </Text>
        </View>
      ) : (
        <>
          <ErrorNotice error={serverError} />
          {mode === "signup" && (
            <Field
              label="昵称"
              value={name}
              onChangeText={(value) => {
                setName(value);
                if (fieldErrors.name) setFieldErrors((prev) => ({ ...prev, name: undefined }));
              }}
              placeholder="怎么称呼你"
            />
          )}
          {fieldErrors.name ? <FieldError text={fieldErrors.name} /> : null}
          <Field
            label="邮箱"
            value={email}
            onChangeText={(value) => {
              setEmail(value);
              if (fieldErrors.email) setFieldErrors((prev) => ({ ...prev, email: undefined }));
            }}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="user@example.com"
          />
          {fieldErrors.email ? <FieldError text={fieldErrors.email} /> : null}
          <Field
            label="密码"
            value={password}
            onChangeText={(value) => {
              setPassword(value);
              if (fieldErrors.password) setFieldErrors((prev) => ({ ...prev, password: undefined }));
            }}
            secureTextEntry
            placeholder="至少 8 位"
          />
          {fieldErrors.password ? <FieldError text={fieldErrors.password} /> : null}
          <Button primary disabled={busy} onPress={() => void submit()}>
            {mode === "signin" ? "登录" : "创建账号"}
          </Button>
          <Pressable
            onPress={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setServerError("");
              setFieldErrors({});
            }}
            style={{ alignItems: "center", paddingVertical: 4 }}
          >
            <Text style={[s.small, { color: colors.blueDark }]}>
              {mode === "signin" ? "还没有账号？注册一个" : "已有账号？直接登录"}
            </Text>
          </Pressable>
        </>
      )}
    </Card>
  );
}

function FieldError({ text }: { text: string }) {
  return <Text style={{ color: colors.danger, fontSize: 12, marginTop: -6 }}>{text}</Text>;
}

/** 已登录状态的退出入口（供设置页/侧栏复用）。 */
export function SignOutButton({ onSignedOut }: { onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      small
      busy={busy}
      onPress={() => {
        setBusy(true);
        void signOut()
          .catch(() => undefined)
          .finally(onSignedOut);
      }}
    >
      退出登录
    </Button>
  );
}
