<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import type { ReadonlyRefs } from '../lib/ownerView'
import { Globe2, Link, Monitor, Plus, RotateCcw, ShieldCheck, Trash2, X } from '@lucide/vue'
import type { useHostConnection } from '../lib/hostConnection'
import type { usePageSurfaces } from '../lib/pageSurfaces'
import LocalConnectionCard from './LocalConnectionCard.vue'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'

const props = defineProps<{
  host: ReadonlyRefs<Pick<ReturnType<typeof useHostConnection>, 'addHostEndpoint' | 'beginPairing' | 'chooseConnectionPolicy' | 'connectLocal' | 'endpointCanSaveDraft' | 'endpointError' | 'endpointFormOpen' | 'endpointKindLabel' | 'endpointMutatingId' | 'endpointSaving' | 'endpointStateLabel' | 'hostNameError' | 'hostNameSaved' | 'hostNameSaving' | 'moveEndpoint' | 'pairingError' | 'pairingMessage' | 'pairingPin' | 'pairingStage' | 'rememberPairDeviceName' | 'removeEndpoint' | 'removeSavedHost' | 'saveEndpointDraft' | 'saveHostDisplayName' | 'showHostPairingForm' | 'stopPairing' | 'switchSavedHost' | 'testEndpoint' | 'testStatusLabel' | 'toggleEndpoint' | 'toggleEndpointForm' | 'updateLocalEndpoint'>> & Pick<ReturnType<typeof useHostConnection>, 'addingHost' | 'endpointHost' | 'endpointKind' | 'endpointLabel' | 'endpointPort' | 'hostDisplayName' | 'pairDeviceName' | 'pairHost' | 'pairPort'>
  page: ReadonlyRefs<Pick<ReturnType<typeof usePageSurfaces>, 'closeModal'>>
  busy: boolean
}>()
const app = useAppStore()
const { pairHost, pairPort, pairDeviceName, pairingStage, pairingPin, pairingMessage, pairingError, endpointHost, endpointPort, endpointLabel, endpointKind, endpointSaving, endpointFormOpen, endpointError, endpointCanSaveDraft, endpointMutatingId, hostDisplayName, hostNameSaving, hostNameError, hostNameSaved, addingHost, rememberPairDeviceName, beginPairing, stopPairing, showHostPairingForm, toggleEndpointForm, switchSavedHost, connectLocal, updateLocalEndpoint, removeSavedHost, saveHostDisplayName, addHostEndpoint, saveEndpointDraft, chooseConnectionPolicy, testEndpoint, toggleEndpoint, moveEndpoint, removeEndpoint, endpointKindLabel, endpointStateLabel, testStatusLabel } = props.host
const { closeModal } = props.page
const appBuildIdentity = import.meta.env.VITE_ALUDOCK_BUILD_IDENTITY
onBeforeUnmount(() => { void stopPairing() })
</script>

<template>
        <header class="host-settings-header">
          <div class="host-settings-heading"><img :src="dockIconUrl" alt="" /><div><h2 id="host-settings-title">连接设置</h2><p>本机或 Host · 版本 {{ appBuildIdentity }}</p></div></div>
          <button class="host-settings-close" data-modal-initial aria-label="关闭" @click="closeModal"><X :size="18" /></button>
        </header>
        <div class="host-settings-panel">
          <aside class="host-catalog-section">
            <LocalConnectionCard
              v-if="app.catalog?.localConnectionSupported"
              :connected="!!app.localSelected"
              :effective-endpoint="app.catalog.localEndpointEffective"
              :endpoint-override="app.catalog.localEndpointOverride"
              :busy="app.loading || props.busy"
              :error="app.error"
              @connect="connectLocal"
              @save="updateLocalEndpoint"
            />
            <div class="host-catalog-title"><span>Host</span><b>{{ app.catalog?.hosts.length ?? 0 }}</b></div>
            <div class="host-catalog-list">
              <article v-for="host in app.catalog?.hosts" :key="host.hostId" class="host-choice" :class="{ active: host.hostId === app.activeHost?.hostId && !app.localSelected }">
                <button class="host-choice-main" :disabled="host.hostId === app.activeHost?.hostId && !app.localSelected || props.busy" @click="switchSavedHost(host.hostId)">
                  <span class="host-choice-dot" aria-hidden="true" />
                  <span class="host-choice-copy"><strong>{{ host.displayName }}</strong><small>{{ host.endpointSummary }}</small></span>
                  <span v-if="host.hostId === app.activeHost?.hostId && !app.localSelected" class="host-choice-current">当前</span>
                </button>
                <button class="host-choice-delete" :aria-label="`从此设备删除 ${host.displayName}`" :disabled="props.busy" @click="removeSavedHost(host.hostId, host.displayName)"><Trash2 :size="14" /></button>
              </article>
            </div>
            <button class="host-connect-new" :disabled="props.busy" @click="showHostPairingForm"><Plus :size="15" />连接 Host</button>
          </aside>
          <div class="host-detail-column">
            <section v-if="app.localSelected && !addingHost" class="local-connection-summary">
              <span class="local-connection-summary-icon"><Monitor :size="21" /></span>
              <div><strong>当前连接：本机 AluDock</strong><p><code>{{ app.catalog?.localEndpointEffective }}</code></p></div>
            </section>
          <form v-if="addingHost" class="pairing-card host-pairing-card" @submit.prevent="beginPairing()">
            <div class="pairing-card-title"><Link :size="18" /><div><strong>连接新的 AluDock</strong><small>配对验证完成后才会加入列表并激活</small></div><button type="button" class="host-inline-close" aria-label="收起配对表单" @click="async () => { await stopPairing(); addingHost = false }"><X :size="15" /></button></div>
            <label><span>IP 地址或域名</span><input v-model="pairHost" autocomplete="off" spellcheck="false" placeholder="192.168.1.20 或 dock.example.com" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" /></label>
            <label><span>端口</span><input v-model.number="pairPort" type="number" min="1" max="65535" /></label>
            <label><span>这台设备的名称</span><input v-model="pairDeviceName" maxlength="128" required autocomplete="off" placeholder="例如 NUC14 或我的 MacBook" @input="rememberPairDeviceName" /><small class="pairing-field-hint">显示在电脑端；修改后会在重新配对时沿用。</small></label>
            <div v-if="pairingPin" class="pairing-pin"><small>请在电脑上的 AluDock 中输入</small><strong>{{ pairingPin }}</strong></div>
            <div v-if="pairingMessage" class="pairing-progress">{{ pairingMessage }}</div>
            <div v-if="pairingError" class="directory-error">{{ pairingError }}</div>
            <div class="pairing-actions"><button v-if="!['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" type="button" class="button secondary" @click="stopPairing">停止等待</button><button v-else class="button primary" :disabled="props.busy || !pairHost.trim() || !pairPort || !pairDeviceName.trim()">开始配对</button></div>
          </form>
          <template v-if="app.activeHost && !app.localSelected && !addingHost">
          <div class="host-detail-intro"><div><span>当前 Host</span><h3>{{ app.activeHost.displayName }}</h3></div><p>{{ app.activeHost.profile.endpoints.length }} 个 TLS 地址 · {{ app.activeHost.profile.policy.mode === 'automatic' ? '自动选择' : '固定首选' }}</p></div>
          <form class="host-profile-form" @submit.prevent="saveHostDisplayName">
            <div><strong>Host 名称</strong><small>仅修改此设备上显示的名称；地址和配对关系保持原样。</small></div>
            <div class="host-name-field"><input v-model="hostDisplayName" maxlength="128" autocomplete="off" placeholder="例如 家里的工作站" :disabled="hostNameSaving" /><button class="button secondary" :disabled="hostNameSaving || hostDisplayName.trim() === app.activeHost?.displayName">{{ hostNameSaving ? '保存中…' : '保存名称' }}</button></div>
            <p v-if="hostNameError" class="host-name-error">{{ hostNameError }}</p>
            <p v-else-if="hostNameSaved" class="host-name-success">Host 名称已保存。</p>
          </form>
          <div class="connection-policy">
            <div><Globe2 :size="18" /><span><strong>自动选择 TLS 地址</strong><small>优先局域网，不可达时尝试外网 / VPN 地址</small></span></div>
            <button :class="{ selected: app.activeHost?.profile.policy.mode === 'automatic' }" @click="chooseConnectionPolicy('automatic')">{{ app.activeHost?.profile.policy.mode === 'automatic' ? '已启用' : '启用' }}</button>
          </div>
          <section class="endpoint-section">
            <div class="host-section-heading"><div><h3>连接地址</h3><p class="endpoint-order-note">按局域网、VPN、广域网和手动地址的顺序自动尝试。</p></div><button class="host-add-endpoint" @click="toggleEndpointForm"><Plus :size="14" />{{ endpointFormOpen ? '收起' : '添加地址' }}</button></div>
            <div class="endpoint-list">
              <article v-for="(endpoint, index) in app.activeHost?.profile.endpoints" :key="endpoint.id" class="endpoint-row" :class="[`state-${endpoint.state}`]">
                <span class="endpoint-icon"><ShieldCheck :size="17" /></span>
                <div class="endpoint-detail">
                  <strong>{{ endpoint.label }}</strong>
                  <code>{{ endpoint.endpoint.host }}:{{ endpoint.endpoint.port }}</code>
                  <small>{{ endpointKindLabel(endpoint.kind) }} · {{ endpointStateLabel(endpoint) }}</small>
                  <small v-if="endpoint.lastManualTest" :class="endpoint.lastManualTest.succeeded ? 'test-success' : 'test-failure'">{{ testStatusLabel(endpoint) }}</small>
                </div>
                <div class="endpoint-actions">
                  <button :disabled="index === 0 || !!endpointMutatingId" :aria-label="`上移 ${endpoint.label}`" @click="moveEndpoint(endpoint.id, -1)">↑</button>
                  <button :disabled="index === (app.activeHost?.profile.endpoints.length ?? 0) - 1 || !!endpointMutatingId" :aria-label="`下移 ${endpoint.label}`" @click="moveEndpoint(endpoint.id, 1)">↓</button>
                  <button :disabled="!!endpointMutatingId" @click="testEndpoint(endpoint)">{{ endpointMutatingId === endpoint.id ? '测试中…' : endpoint.state === 'draft_unverified' ? '验证' : '测试' }}</button>
                  <button :disabled="!!endpointMutatingId" @click="toggleEndpoint(endpoint)">{{ endpoint.state === 'disabled' ? '重新启用' : '停用' }}</button>
                  <button v-if="endpoint.state === 'verified'" class="endpoint-use" :class="{ selected: app.activeHost?.profile.policy.mode === 'fixed' && app.activeHost!.profile.policy.endpointId === endpoint.id }" :disabled="!!endpointMutatingId" @click="chooseConnectionPolicy('fixed', endpoint.id)">{{ app.activeHost?.profile.policy.mode === 'fixed' && app.activeHost.profile.policy.endpointId === endpoint.id ? '已设为首选' : '设为首选' }}</button>
                  <button class="endpoint-delete" :aria-label="`删除地址 ${endpoint.label}`" :disabled="!!endpointMutatingId" @click="removeEndpoint(endpoint.id, endpoint.label)"><Trash2 :size="15" /></button>
                </div>
              </article>
            </div>
          </section>
          <form v-if="endpointFormOpen" class="endpoint-form" @submit.prevent="addHostEndpoint">
            <div><h3>添加连接地址</h3><p>例如外网 DDNS 域名。验证为同一台 AluDock 后才会保存并参与自动连接。</p></div>
            <div class="endpoint-fields">
              <label><span>备注</span><input v-model="endpointLabel" maxlength="128" placeholder="外网域名" /></label>
              <label><span>类型</span><select v-model="endpointKind"><option value="remote">广域网</option><option value="local">局域网</option><option value="vpn">VPN</option><option value="manual">其他</option></select></label>
              <label class="endpoint-host"><span>IP 地址或域名</span><input v-model="endpointHost" spellcheck="false" placeholder="dock.example.com" /></label>
              <label><span>端口</span><input v-model.number="endpointPort" type="number" inputmode="numeric" min="1" max="65535" placeholder="端口" /></label>
            </div>
            <div v-if="endpointError" class="directory-error">{{ endpointError }}</div>
            <div v-if="endpointCanSaveDraft" class="endpoint-draft-offer"><span>当前网络无法完成验证。可先保存为待验证草稿；验证通过后才会参与自动连接。</span><button type="button" class="button secondary" :disabled="endpointSaving" @click="saveEndpointDraft">保存为待验证草稿</button></div>
            <footer><span><ShieldCheck :size="14" />原配对保持不变</span><button class="button primary" :disabled="!endpointHost.trim() || !endpointPort || endpointSaving">{{ endpointSaving ? '正在验证…' : '验证并添加' }}</button></footer>
          </form>
          </template>
          </div>
        </div>

</template>

<style scoped>
.host-profile-form { display: grid; gap: 9px; padding: 13px 14px; margin-bottom: 12px; background: rgb(244 114 182 / .04); border: 1px solid rgb(244 114 182 / .15); border-radius: 11px; }
.host-profile-form > div:first-child { display: grid; gap: 4px; }
.host-profile-form strong { font-size: 11px; }
.host-profile-form small { color: var(--c-text-3); font: 9px/1.5 var(--font-reading); }
.host-name-field { display: flex; align-items: center; gap: 8px; }
.host-name-field input { min-width: 0; height: 38px; flex: 1; padding: 0 10px; color: var(--c-text-1); font: 11px var(--font-reading); background: var(--c-space-850); border: 1px solid var(--c-line); border-radius: 8px; outline: none; }
.host-name-field input:focus { border-color: var(--c-ice); }
.host-name-field .button { flex: 0 0 auto; }
.host-name-error, .host-name-success { margin: 0; font: 9px/1.45 var(--font-reading); }
.host-name-error { color: var(--c-danger); }
.host-name-success { color: var(--c-success); }
.connection-policy { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 14px; background: rgb(126 200 224 / .05); border: 1px solid rgb(126 200 224 / .16); border-radius: 11px; }
.connection-policy > div { display: flex; align-items: center; gap: 10px; }
.connection-policy svg { flex: 0 0 auto; color: var(--c-ice); }
.connection-policy span { display: grid; gap: 4px; }
.connection-policy strong { font-size: 11px; }
.connection-policy small { color: var(--c-text-3); font: 10px/1.45 var(--font-reading); }
.connection-policy button, .endpoint-use { padding: 6px 9px; color: var(--c-text-2); font: 600 9px var(--font-ui); cursor: pointer; background: var(--c-space-850); border: 1px solid var(--c-line); border-radius: 7px; }
.connection-policy button.selected, .endpoint-use.selected { color: var(--c-pink); background: rgb(244 114 182 / .08); border-color: rgb(244 114 182 / .28); }
.endpoint-section { margin-top: 17px; }
.endpoint-section h3, .endpoint-form h3 { margin: 0 0 8px; font-size: 11px; }
.endpoint-order-note { margin: -2px 0 10px; color: var(--c-text-3); font: 9px/1.45 var(--font-reading); }
.endpoint-list { display: grid; gap: 7px; }
.endpoint-row { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(150px, auto); align-items: center; gap: 10px; padding: 11px; background: var(--c-space-850); border: 1px solid var(--c-line-soft); border-radius: 9px; }
.endpoint-row.state-draft_unverified { border-color: rgb(251 191 36 / .2); }
.endpoint-row.state-disabled { opacity: .72; }
.endpoint-icon { display: grid; width: 31px; height: 31px; color: var(--c-mint); background: rgb(52 211 153 / .07); border-radius: 8px; place-items: center; }
.state-draft_unverified .endpoint-icon { color: var(--c-amber); background: rgb(251 191 36 / .07); }
.state-disabled .endpoint-icon { color: var(--c-text-3); background: rgb(136 152 176 / .07); }
.endpoint-detail { display: grid; min-width: 0; gap: 3px; }
.endpoint-row strong { font-size: 11px; }
.endpoint-row code { overflow: hidden; color: var(--c-text-2); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.endpoint-row small { color: var(--c-text-3); font: 9px/1.35 var(--font-reading); }
.endpoint-row small.test-success { color: var(--c-success); }
.endpoint-row small.test-failure { color: var(--c-danger); }
.endpoint-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.endpoint-actions button { min-height: 29px; padding: 5px 8px; color: var(--c-text-2); font: 600 9px var(--font-ui); cursor: pointer; background: transparent; border: 1px solid var(--c-line); border-radius: 7px; }
.endpoint-actions button:hover:not(:disabled) { color: var(--c-ice); border-color: rgb(126 200 224 / .35); }
.endpoint-actions button:disabled { cursor: default; opacity: .42; }
.endpoint-actions .endpoint-delete { display: grid; width: 30px; padding: 0; color: var(--c-text-3); border-color: transparent; place-items: center; }
.endpoint-actions .endpoint-delete:hover:not(:disabled) { color: var(--c-pink); background: rgb(244 114 182 / .07); }
.endpoint-form { padding: 14px; margin-top: 16px; background: rgb(11 16 32 / .65); border: 1px solid var(--c-line-soft); border-radius: 11px; }
.endpoint-form > div:first-child p { margin: -2px 0 12px; color: var(--c-text-3); font: 10px/1.5 var(--font-reading); }
.endpoint-fields { display: grid; grid-template-columns: 1fr 120px; gap: 9px; }
.endpoint-fields label { display: grid; gap: 5px; color: var(--c-text-3); font-size: 9px; }
.endpoint-fields input, .endpoint-fields select { width: 100%; height: 35px; padding: 0 9px; color: var(--c-text-1); font: 10px var(--font-mono); background: var(--c-space-850); border: 1px solid var(--c-line); border-radius: 7px; outline: none; }
.endpoint-fields select { font-family: var(--font-ui); }
.endpoint-form footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.endpoint-form footer > span { display: flex; align-items: center; gap: 6px; color: var(--c-text-3); font: 9px/1.4 var(--font-reading); }
.endpoint-form footer svg { color: var(--c-mint); }
.endpoint-draft-offer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px; margin-top: 10px; color: var(--c-amber); font: 9px/1.45 var(--font-reading); background: rgb(251 191 36 / .06); border: 1px solid rgb(251 191 36 / .18); border-radius: 8px; }
.endpoint-draft-offer .button { flex: 0 0 auto; }
@media (max-width: 599px) {
  .host-name-field { align-items: stretch; flex-direction: column; }
  .host-name-field .button { width: 100%; }
  .connection-policy { align-items: flex-start; }
  .endpoint-row { grid-template-columns: auto minmax(0, 1fr); align-items: start; }
  .endpoint-actions { grid-column: 1 / -1; justify-content: flex-start; }
  .endpoint-actions button { min-height: 40px; }
  .endpoint-fields { grid-template-columns: 1fr; }
  .endpoint-form footer, .endpoint-draft-offer { align-items: stretch; flex-direction: column; }
  .endpoint-form footer .button, .endpoint-draft-offer .button { width: 100%; }
}
.host-settings-header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px 12px 20px;
  border-bottom: 1px solid var(--alu-border);
  background: color-mix(in srgb, var(--alu-bg-raised) 75%, transparent);
}
.host-settings-heading { display: flex; min-width: 0; align-items: center; gap: 11px; }
.host-settings-heading img { width: 36px; height: 36px; flex: 0 0 auto; object-fit: cover; border: 1px solid var(--alu-border); border-radius: 10px; }
.host-settings-heading h2 { margin: 0; color: var(--alu-text); font-size: 14px; font-weight: 700; letter-spacing: .01em; }
.host-settings-heading p { margin: 3px 0 0; overflow: hidden; color: var(--alu-text-dim); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.host-settings-close,
.host-inline-close {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--alu-text-muted);
  place-items: center;
}
.host-settings-close:hover,
.host-inline-close:hover {
  border-color: var(--alu-border);
  background: var(--alu-hover);
  color: var(--alu-text);
}
.host-settings-panel {
  display: grid;
  min-height: 0;
  max-height: none;
  grid-template-columns: 218px minmax(0, 1fr);
  padding: 0;
  overflow: hidden;
}
.host-catalog-section {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  padding: 18px 12px 12px;
  border-right: 1px solid var(--alu-border);
  background: color-mix(in srgb, var(--alu-bg) 82%, #070b14);
}
.host-catalog-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 7px 10px;
  color: var(--alu-text-faint);
  font-size: 9px;
  font-weight: 750;
  letter-spacing: .11em;
  text-transform: uppercase;
}
.host-catalog-title b { min-width: 19px; padding: 2px 5px; border-radius: 999px; background: var(--alu-bg-raised); color: var(--alu-text-muted); font-size: 8px; text-align: center; }
.host-catalog-list { min-height: 0; flex: 1 1 auto; overflow-y: auto; }
.host-choice { position: relative; display: flex; min-width: 0; align-items: stretch; margin: 2px 0; border: 1px solid transparent; border-radius: 9px; }
.host-choice:hover { background: var(--alu-hover); }
.host-choice.active { border-color: var(--alu-pink-border); background: var(--alu-pink-bg); }
.host-choice.active::before { position: absolute; top: 9px; bottom: 9px; left: -1px; width: 2px; border-radius: 0 2px 2px 0; background: var(--alu-pink); content: ''; }
.host-choice-main {
  display: grid;
  min-width: 0;
  min-height: 52px;
  flex: 1 1 auto;
  grid-template-columns: 7px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 8px 5px 8px 9px;
  cursor: pointer;
  text-align: left;
}
.host-choice-main:disabled { cursor: default; opacity: 1; }
.host-choice-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--alu-text-faint); }
.host-choice.active .host-choice-dot { background: var(--alu-mint); box-shadow: 0 0 7px color-mix(in srgb, var(--alu-mint) 48%, transparent); }
.host-choice-copy { display: grid; min-width: 0; gap: 3px; }
.host-choice-copy strong,
.host-choice-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-choice-copy strong { color: var(--alu-text); font-size: 11px; font-weight: 650; }
.host-choice-copy small { color: var(--alu-text-muted); font: 8px/1.35 var(--font-mono); }
.host-choice-current { padding: 2px 5px; border-radius: 5px; background: color-mix(in srgb, var(--alu-pink) 10%, transparent); color: var(--alu-pink); font-size: 8px; }
.host-choice-delete {
  display: grid;
  width: 30px;
  flex: 0 0 auto;
  cursor: pointer;
  color: var(--alu-text-faint);
  opacity: 0;
  place-items: center;
}
.host-choice:hover .host-choice-delete,
.host-choice-delete:focus-visible {
  opacity: 1;
}
.host-choice-delete:hover { color: var(--alu-rose); }
.host-choice-delete:disabled { cursor: default; opacity: .28; }
.host-connect-new {
  display: flex;
  min-height: 38px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: 10px;
  cursor: pointer;
  border: 1px dashed color-mix(in srgb, var(--alu-blue) 36%, var(--alu-border));
  border-radius: 9px;
  color: var(--alu-blue);
  font-size: 9px;
}
.host-connect-new:hover { border-style: solid; background: color-mix(in srgb, var(--alu-blue) 7%, transparent); }
.host-connect-new:disabled { cursor: default; opacity: .4; }
.host-detail-column {
  min-width: 0;
  min-height: 0;
  padding: 22px 25px 30px;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.host-detail-intro { display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-bottom: 18px; padding: 0 2px 16px; border-bottom: 1px solid var(--alu-border); }
.host-detail-intro span { color: var(--alu-pink); font-size: 8px; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
.host-detail-intro h3 { margin: 4px 0 0; color: var(--alu-text); font-size: 18px; font-weight: 650; }
.host-detail-intro p { margin: 0 0 2px; color: var(--alu-text-muted); font-size: 9px; white-space: nowrap; }
.host-detail-column .host-profile-form,
.host-detail-column .connection-policy {
  margin: 0 0 12px;
  border-color: var(--alu-border);
  border-radius: 10px;
  background: var(--alu-bg-raised);
}
.host-inline-close { width: 30px; height: 30px; margin-left: auto; }
.host-detail-column .host-profile-form { padding: 15px; }
.host-detail-column .host-profile-form strong { color: var(--alu-text); font-size: 11px; }
.host-detail-column .host-profile-form small { color: var(--alu-text-muted); font-size: 9px; }
.host-detail-column .host-name-field input,
.host-detail-column .endpoint-fields input,
.host-detail-column .endpoint-fields select {
  border-color: var(--alu-border);
  background: var(--alu-bg);
  color: var(--alu-text);
}
.host-detail-column .connection-policy { padding: 14px 15px; }
.local-connection-summary { display: flex; align-items: center; gap: 11px; margin-bottom: 12px; padding: 15px; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg-raised); }
.local-connection-summary-icon { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border-radius: 9px; color: var(--alu-mint); background: color-mix(in srgb, var(--alu-mint) 9%, transparent); }
.local-connection-summary > div { display: grid; min-width: 0; flex: 1; gap: 4px; }
.local-connection-summary strong { color: var(--alu-text); font-size: 11px; }
.local-connection-summary p { min-width: 0; margin: 0; overflow: hidden; color: var(--alu-text-muted); font: 9px/1.45 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.host-detail-column .connection-policy strong { color: var(--alu-text); }
.host-detail-column .connection-policy small { color: var(--alu-text-muted); }
.host-detail-column .connection-policy button,
.host-detail-column .endpoint-use {
  border-color: var(--alu-border);
  background: var(--alu-bg);
}
.host-section-heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.host-section-heading h3 { margin: 0 0 4px; color: var(--alu-text); font-size: 12px; }
.host-section-heading .endpoint-order-note { margin: 0; color: var(--alu-text-muted); font-size: 8px; }
.host-add-endpoint { display: inline-flex; min-height: 30px; flex: 0 0 auto; align-items: center; gap: 5px; padding: 0 9px; cursor: pointer; border: 1px solid var(--alu-border); border-radius: 7px; color: var(--alu-blue); font-size: 9px; }
.host-add-endpoint:hover { border-color: var(--alu-blue-border); background: var(--alu-blue-bg); }
.host-detail-column .endpoint-section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--alu-border); }
.host-detail-column .endpoint-list { gap: 0; overflow: hidden; border: 1px solid var(--alu-border); border-radius: 10px; background: var(--alu-bg-raised); }
.host-detail-column .endpoint-row { grid-template-columns: 30px minmax(0, 1fr) minmax(150px, auto); gap: 10px; padding: 11px 10px; border: 0; border-radius: 0; background: transparent; }
.host-detail-column .endpoint-row + .endpoint-row { border-top: 1px solid var(--alu-border); }
.host-detail-column .endpoint-row:hover { background: var(--alu-hover); }
.host-detail-column .endpoint-icon { width: 29px; height: 29px; }
.host-detail-column .endpoint-actions button { min-height: 27px; border-color: var(--alu-border); font-size: 8px; }
.host-detail-column .endpoint-form { margin-top: 10px; border-color: var(--alu-blue-border); background: color-mix(in srgb, var(--alu-blue-bg) 46%, var(--alu-bg-raised)); }
@media (hover: none) {
  .host-choice-delete { opacity: .65; }
}
@media (max-width: 680px) {
  .host-settings-header { min-height: 62px; padding-left: 15px; }
  .host-settings-heading img { width: 34px; height: 34px; }
  .host-settings-panel { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .host-catalog-section { max-height: min(43dvh, 360px); padding: 12px 10px 10px; overflow-y: auto; border-right: 0; border-bottom: 1px solid var(--alu-border); }
  .host-catalog-title { padding-bottom: 7px; }
  .host-catalog-list { display: flex; flex: 0 0 auto; gap: 6px; overflow-x: auto; overflow-y: hidden; }
  .host-choice { min-width: min(220px, 70vw); margin: 0; }
  .host-connect-new { min-height: 40px; margin-top: 7px; }
  .host-detail-column { padding: 17px 14px 26px; }
  .host-detail-intro { align-items: flex-start; flex-direction: column; gap: 6px; }
  .host-detail-column .endpoint-row { grid-template-columns: 30px minmax(0, 1fr); align-items: start; }
  .host-detail-column .endpoint-actions { grid-column: 1 / -1; justify-content: flex-start; padding-left: 39px; }
  .host-section-heading { align-items: flex-start; }
  .host-detail-column .host-name-field,
  .host-detail-column .connection-policy,
  .host-detail-column .endpoint-form footer,
  .host-detail-column .endpoint-draft-offer {
    align-items: stretch;
    flex-direction: column;
  }
  .host-detail-column .host-name-field .button,
  .host-detail-column .endpoint-form footer .button,
  .host-detail-column .endpoint-draft-offer .button {
    width: 100%;
  }
  .host-detail-column .endpoint-fields { grid-template-columns: 1fr; }
}
</style>
