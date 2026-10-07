import { computed, onMounted, shallowRef } from "vue";
import {
  api,
  type CloudManagementSession,
  type CloudRestoreResult,
  type CloudService,
  type CloudStatus,
} from "../api.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";

export function useCloud() {
  const status = shallowRef<CloudStatus | null>(null);
  const error = shallowRef("");
  const errorVisible = shallowRef(false);
  const recoveryKey = shallowRef("");
  const restoring = shallowRef(false);
  const refreshing = shallowRef(false);
  const confirmationService = shallowRef<CloudService | null>(null);
  const serviceUpdating = shallowRef<CloudService | null>(null);
  const statusRequests = createRequestGate();
  const managing = shallowRef(false);
  const busy = computed(
    () => refreshing.value || restoring.value || serviceUpdating.value !== null,
  );

  const subscribed = computed(() => {
    const services = new Set(
      status.value?.entitlements.map((item) => item.service) ?? [],
    );
    return services.has("remote_mcp") && services.has("remote_web");
  });

  const subscriptionExpiry = computed(() => {
    const values = (status.value?.entitlements ?? [])
      .map((item) => item.validUntil)
      .filter((value): value is string => Boolean(value))
      .map((value) => Date.parse(value))
      .filter(Number.isFinite);
    return values.length ? Math.min(...values) : null;
  });

  onMounted(() => void load());

  function showError(value: unknown) {
    error.value = errorMessage(value);
    errorVisible.value = true;
  }

  async function load() {
    if (busy.value) return;
    const request = statusRequests.begin();
    try {
      const next = await api<CloudStatus>("/cloud/status", {
        signal: request.signal,
      });
      if (statusRequests.isCurrent(request)) status.value = next;
    } catch (value) {
      if (statusRequests.isCurrent(request)) showError(value);
    }
  }

  async function refresh() {
    if (busy.value) return;
    const request = statusRequests.begin();
    refreshing.value = true;
    try {
      const next = await api<CloudStatus>("/cloud/sync", {
        method: "POST",
        signal: request.signal,
      });
      if (statusRequests.isCurrent(request)) status.value = next;
    } catch (value) {
      if (statusRequests.isCurrent(request)) showError(value);
    } finally {
      refreshing.value = false;
    }
  }

  async function manage() {
    if (managing.value) return;
    managing.value = true;
    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    try {
      const result = await api<CloudManagementSession>("/cloud/management", {
        method: "POST",
      });
      if (popup) popup.location.href = result.url;
      else window.location.assign(result.url);
    } catch (value) {
      popup?.close();
      showError(value);
    } finally {
      managing.value = false;
    }
  }

  function requestServiceChange(service: CloudService, enabled: boolean) {
    if (busy.value) return;
    if (enabled) {
      void setService(service, true);
      return;
    }
    confirmationService.value = service;
  }

  async function confirmDisableService() {
    const service = confirmationService.value;
    if (!service) return;
    await setService(service, false);
    if (serviceUpdating.value === null) confirmationService.value = null;
  }

  async function setService(service: CloudService, enabled: boolean) {
    if (!status.value || busy.value) return;
    const request = statusRequests.begin();
    serviceUpdating.value = service;
    try {
      const next = await api<CloudStatus>(`/cloud/services/${service}`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
        signal: request.signal,
      });
      if (statusRequests.isCurrent(request)) status.value = next;
    } catch (value) {
      if (statusRequests.isCurrent(request)) showError(value);
    } finally {
      if (serviceUpdating.value === service) serviceUpdating.value = null;
    }
  }

  async function restore() {
    if (!recoveryKey.value.trim() || busy.value) return;
    const request = statusRequests.begin();
    const key = recoveryKey.value.trim();
    restoring.value = true;
    try {
      const result = await api<CloudRestoreResult>("/cloud/restore", {
        method: "POST",
        body: JSON.stringify({ recoveryKey: key }),
        timeoutMs: 120_000,
        signal: request.signal,
      });
      if (!statusRequests.isCurrent(request)) return;
      status.value = result.status;
      recoveryKey.value = "";
    } catch (value) {
      if (statusRequests.isCurrent(request)) showError(value);
    } finally {
      restoring.value = false;
    }
  }

  return {
    status,
    error,
    errorVisible,
    recoveryKey,
    restoring,
    refreshing,
    managing,
    busy,
    confirmationService,
    serviceUpdating,
    subscribed,
    subscriptionExpiry,
    load,
    refresh,
    manage,
    requestServiceChange,
    confirmDisableService,
    restore,
  };
}
