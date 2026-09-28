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
