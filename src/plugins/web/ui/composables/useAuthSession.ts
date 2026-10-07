import { computed, onMounted, shallowRef } from "vue";
import { useLocale } from "vuetify";
import { api, type AuthStatus, type PasskeySummary } from "../api.js";
import { errorMessage } from "../utils/errors.js";
import type {
  startAuthentication as StartAuthentication,
  startRegistration as StartRegistration,
} from "@simplewebauthn/browser";

type AuthenticationOptionsJSON = Parameters<
  typeof StartAuthentication
>[0]["optionsJSON"];
type RegistrationOptionsJSON = Parameters<
  typeof StartRegistration
>[0]["optionsJSON"];

interface AuthSessionOptions {
  onAuthenticated(): void;
  onSignedOut(): void;
}

export function useAuthSession(options: AuthSessionOptions) {
  const locale = useLocale();
  const authenticated = shallowRef<boolean | null>(null);
  const passkeyServerAvailable = shallowRef(false);
  const passkeyRegistered = shallowRef(false);
  const passkeyBrowserAvailable = shallowRef(
    typeof window.PublicKeyCredential !== "undefined",
  );
  const passkeyBusy = shallowRef(false);
  const loginBusy = shallowRef(false);
  const passkeyDialog = shallowRef(false);
  const passkeys = shallowRef<PasskeySummary[]>([]);
  const passkeyName = shallowRef("");
  const token = shallowRef("");
  const remember = shallowRef(true);
  const loginError = shallowRef("");
  const passkeyError = shallowRef("");

  const canUsePasskeys = computed(
    () => passkeyServerAvailable.value && passkeyBrowserAvailable.value,
  );

  onMounted(initialize);

  async function initialize() {
    try {
      const status = await api<AuthStatus>("/auth/status");
      authenticated.value = status.authenticated;
      passkeyServerAvailable.value = status.passkeyAvailable;
      passkeyRegistered.value = status.passkeyRegistered;
    } catch {
      authenticated.value = false;
    }
    if (authenticated.value) options.onAuthenticated();
  }

  async function login() {
    if (loginBusy.value || passkeyBusy.value || !token.value.trim()) return;
    loginBusy.value = true;
    loginError.value = "";
    try {
      await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          ownerToken: token.value,
          remember: remember.value,
        }),
      });
      completeLogin();
    } catch (cause) {
      loginError.value = errorMessage(cause);
    } finally {
      loginBusy.value = false;
    }
  }

  async function loginWithPasskey() {
    if (loginBusy.value || passkeyBusy.value) return;
    loginError.value = "";
    passkeyBusy.value = true;
    try {
      const request = await api<{
        challengeId: string;
        options: AuthenticationOptionsJSON;
      }>("/auth/passkey/options", { method: "POST" });
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const response = await startAuthentication({
        optionsJSON: request.options,
      });
      await api("/auth/passkey/verify", {
        method: "POST",
        body: JSON.stringify({
          challengeId: request.challengeId,
          response,
          remember: remember.value,
        }),
      });
      completeLogin();
    } catch (cause) {
      loginError.value = errorMessage(cause);
    } finally {
      passkeyBusy.value = false;
    }
  }

  function completeLogin() {
    authenticated.value = true;
    token.value = "";
    loginError.value = "";
    options.onAuthenticated();
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    authenticated.value = false;
    options.onSignedOut();
  }

  async function openPasskeyManager() {
    passkeyDialog.value = true;
    passkeyError.value = "";
    passkeyName.value = locale.t("$vuetify.chatroom.auth.thisDevice");
    await loadPasskeys();
  }

  async function loadPasskeys() {
    try {
      passkeys.value = await api<PasskeySummary[]>("/auth/passkeys");
      passkeyRegistered.value = passkeys.value.length > 0;
    } catch (cause) {
      passkeyError.value = errorMessage(cause);
    }
  }

  async function registerPasskey() {
    if (passkeyBusy.value) return;
    passkeyError.value = "";
    passkeyBusy.value = true;
    try {
      const request = await api<{
        challengeId: string;
        options: RegistrationOptionsJSON;
      }>("/auth/passkeys/register/options", { method: "POST" });
      const { startRegistration } = await import("@simplewebauthn/browser");
      const response = await startRegistration({
        optionsJSON: request.options,
      });
      await api("/auth/passkeys/register/verify", {
        method: "POST",
        body: JSON.stringify({
          challengeId: request.challengeId,
          response,
          name: passkeyName.value,
        }),
      });
      await loadPasskeys();
    } catch (cause) {
      passkeyError.value = errorMessage(cause);
    } finally {
      passkeyBusy.value = false;
    }
  }

  async function removePasskey(id: string) {
    if (passkeyBusy.value) return;
    passkeyBusy.value = true;
    passkeyError.value = "";
    try {
      await api(`/auth/passkeys/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      await loadPasskeys();
    } catch (cause) {
      passkeyError.value = errorMessage(cause);
    } finally {
      passkeyBusy.value = false;
    }
  }

  return {
    authenticated,
    canUsePasskeys,
    passkeyRegistered,
    passkeyBusy,
    loginBusy,
    passkeyDialog,
    passkeys,
    passkeyName,
    token,
    remember,
    loginError,
    passkeyError,
    login,
    loginWithPasskey,
    logout,
    openPasskeyManager,
    registerPasskey,
    removePasskey,
  };
}
