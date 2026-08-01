import React, { useCallback, useEffect, useState } from "react";
import {
  addVendor,
  listModelProfiles,
  listProviders,
  removeProvider,
  type ModelProfileConfig,
  type ProviderConfig,
} from "../api";
import { theme } from "../theme";

interface FormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  contextWindow: string;
}

const EMPTY_FORM: FormState = { name: "", baseUrl: "", apiKey: "", modelName: "", contextWindow: "" };

export function VendorsPage() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [profiles, setProfiles] = useState<ModelProfileConfig[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const [p, m] = await Promise.all([listProviders(), listModelProfiles()]);
    setProviders(p.data);
    setProfiles(m.data);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setField = (key: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.modelName.trim()) {
      setMessage({ ok: false, text: "供应商名称和模型名称不能为空" });
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await addVendor({
        name: form.name.trim(),
        ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        modelName: form.modelName.trim(),
        ...(form.contextWindow.trim() ? { contextWindow: Number(form.contextWindow) } : {}),
      });
      if (result.status !== 200) {
        const error = (result.data as { error?: { message?: string } }).error;
        setMessage({ ok: false, text: `添加失败：${error?.message ?? result.status}` });
        return;
      }
      const vendor = result.data as { provider: { id: string }; modelProfile: { name: string } };
      setMessage({
        ok: true,
        text: `添加成功：${vendor.provider.id} → ${vendor.modelProfile.name}`,
      });
      setForm(EMPTY_FORM);
      await refresh();
    } catch (error) {
      setMessage({ ok: false, text: `请求失败：${String(error)}` });
    } finally {
      setSubmitting(false);
    }
  };

  const onRemove = async (id: string) => {
    const result = await removeProvider(id);
    if (result.status === 200) {
      setMessage({ ok: true, text: `已删除 ${id}` });
      await refresh();
    } else {
      setMessage({ ok: false, text: `删除失败：${result.status}` });
    }
  };

  return (
    <div>
      <h2 style={styles.title}>供应商管理</h2>

      <section style={styles.card}>
        <h3 style={styles.cardTitle}>添加供应商</h3>
        <form onSubmit={onSubmit}>
          <div style={styles.grid}>
            <label style={styles.field}>
              <span style={styles.label}>供应商名称 *</span>
              <input style={styles.input} value={form.name} onChange={setField("name")} placeholder="如 DeepSeek" />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>API 地址</span>
              <input style={styles.input} value={form.baseUrl} onChange={setField("baseUrl")} placeholder="如 https://api.deepseek.com" />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>API Key</span>
              <input style={styles.input} type="password" value={form.apiKey} onChange={setField("apiKey")} placeholder="sk-...（存 SecretStore）" />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>模型名称 *</span>
              <input style={styles.input} value={form.modelName} onChange={setField("modelName")} placeholder="如 deepseek-chat" />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>上下文（tokens）</span>
              <input style={styles.input} type="number" min={1} value={form.contextWindow} onChange={setField("contextWindow")} placeholder="如 65536" />
            </label>
          </div>
          <button style={styles.button} type="submit" disabled={submitting}>
            {submitting ? "添加中..." : "添加供应商"}
          </button>
          {message && (
            <div style={message.ok ? styles.msgOk : styles.msgErr}>{message.text}</div>
          )}
        </form>
      </section>

      <section style={styles.card}>
        <h3 style={styles.cardTitle}>已配置的供应商</h3>
        {providers.length === 0 ? (
          <div style={styles.empty}>还没有供应商，先用上面的表单添加一个。</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>ID</th>
                <th style={styles.th}>名称</th>
                <th style={styles.th}>API 地址</th>
                <th style={styles.th}>密钥引用</th>
                <th style={styles.th}>模型</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => {
                const related = profiles.filter((p) => p.providerId === provider.id);
                return (
                  <tr key={provider.id}>
                    <td style={styles.mono}>{provider.id}</td>
                    <td>{provider.name}</td>
                    <td style={styles.mono}>{provider.baseUrl ?? "-"}</td>
                    <td style={styles.mono}>{provider.apiKeySecretRef ?? "-"}</td>
                    <td>
                      {related.length > 0
                        ? related.map((p) => `${p.modelName}${p.contextWindow ? ` (${p.contextWindow})` : ""}`).join("、")
                        : "-"}
                    </td>
                    <td>
                      <button style={styles.linkButton} onClick={() => void onRemove(provider.id)}>
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  title: { margin: "0 0 20px", fontSize: 22, fontWeight: 700 },
  card: {
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius + 4,
    padding: 22,
    marginBottom: 20,
    boxShadow: theme.shadowSm,
  },
  cardTitle: { margin: "0 0 16px", fontSize: 15, fontWeight: 600 },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" },
  field: { display: "block", marginBottom: 14 },
  label: { display: "block", fontSize: 12, color: theme.textDim, marginBottom: 5 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "9px 12px",
    background: theme.surfaceAlt,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    fontSize: 14,
    color: theme.text,
    outline: "none",
  },
  button: {
    marginTop: 4,
    padding: "10px 20px",
    background: theme.primary,
    color: theme.primaryText,
    border: 0,
    borderRadius: theme.radiusSm,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  msgOk: { marginTop: 12, fontSize: 13, color: theme.success },
  msgErr: { marginTop: 12, fontSize: 13, color: theme.danger },
  empty: { fontSize: 13, color: theme.textFaint },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", fontSize: 11, color: theme.textFaint, padding: "0 12px 10px 0", fontWeight: 600 },
  td: { padding: "10px 12px 10px 0", borderTop: `1px solid ${theme.border}` },
  mono: { fontFamily: theme.mono, fontSize: 12, color: theme.textDim },
  linkButton: {
    background: "none",
    border: "none",
    color: theme.danger,
    cursor: "pointer",
    fontSize: 13,
    padding: 0,
  },
};
