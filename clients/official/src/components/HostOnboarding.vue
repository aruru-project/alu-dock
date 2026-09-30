<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { Link } from '@lucide/vue'
import LocalConnectionCard from './LocalConnectionCard.vue'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'
import { useHostStore } from '../stores/host'

const app = useAppStore()
const hostStore = useHostStore()
const { pairHost, pairPort, pairDeviceName, pairingStage, pairingPin, pairingMessage, pairingError } = storeToRefs(hostStore)
const { rememberPairDeviceName, beginPairing, stopPairing, connectLocal, updateLocalEndpoint } = hostStore
const { pairingInProgress: busy } = storeToRefs(hostStore)
onBeforeUnmount(() => { void stopPairing() })
</script>

<template>
    <div class="pairing-onboarding">
      <div class="pairing-intro">
        <img :src="dockIconUrl" alt="Alu Dock" />
        <div><span class="eyebrow">WELCOME TO ALUDOCK</span><h1>连接你的 AluDock</h1><p>连接这台设备上的 AluDock，或通过配对连接其他电脑。</p></div>
      </div>
      <div class="pairing-layout">
        <form class="pairing-card" @submit.prevent="beginPairing()">
          <LocalConnectionCard
            v-if="app.catalog?.localConnectionSupported"
            :connected="!!app.localSelected"
            :effective-endpoint="app.catalog.localEndpointEffective"
            :endpoint-override="app.catalog.localEndpointOverride"
            :busy="app.loading || busy"
            :error="app.error"
            @connect="connectLocal"
            @save="updateLocalEndpoint"
          />
          <div v-if="app.catalog?.localConnectionSupported" class="pairing-method-divider"><span>或通过配对连接其他电脑</span></div>
          <div class="pairing-card-title"><Link :size="18" /><div><strong>电脑连接信息</strong><small>地址只用于找到电脑，配对后会单独验证 Host 身份</small></div></div>
          <label><span>IP 地址或域名</span><input v-model="pairHost" autocomplete="off" spellcheck="false" placeholder="例如 192.168.1.20 或 dock.example.com" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" /></label>
          <label><span>端口</span><input v-model.number="pairPort" type="number" inputmode="numeric" min="1" max="65535" placeholder="从电脑端 AluDock 查看" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" /></label>
          <label><span>这台设备的名称</span><input v-model="pairDeviceName" maxlength="128" required autocomplete="off" placeholder="例如 NUC14 或我的 MacBook" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" @input="rememberPairDeviceName" /><small class="pairing-field-hint">显示在电脑端；修改后会在重新配对时沿用。</small></label>
          <div v-if="pairingPin" class="pairing-pin"><small>请在电脑上的 AluDock 中输入</small><strong>{{ pairingPin }}</strong><span>不要把配对码发给其他人</span></div>
          <div v-if="pairingMessage" class="pairing-progress"><span v-if="!['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" class="alu-spinner" />{{ pairingMessage }}</div>
          <div v-if="pairingError || app.error" class="directory-error">{{ pairingError || app.error }}</div>
          <div class="pairing-actions">
            <button v-if="!['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" type="button" class="button secondary" @click="stopPairing">取消</button>
            <button v-else type="submit" class="button primary" :disabled="!pairHost.trim() || !pairPort || !pairDeviceName.trim()">{{ pairingStage === 'failed' ? '重新尝试' : '开始配对' }}</button>
          </div>
        </form>
        <ol class="pairing-guide">
          <li><span>1</span><div><strong>在电脑上打开 AluDock</strong><p>进入 Remote Access / 配对，并打开五分钟配对窗口。</p></div></li>
          <li><span>2</span><div><strong>填写电脑地址与端口</strong><p>在家中通常填写局域网 IP；配对后还能为同一 Host 添加外网域名。</p></div></li>
          <li><span>3</span><div><strong>把四位码输入电脑端</strong><p>客户端会继续验证安全连接，确认完成后自动进入 Work 列表。</p></div></li>
        </ol>
      </div>
    </div>

</template>

<style scoped>
.eyebrow { color: var(--c-sakura); font-size: var(--alu-meta-size); font-weight: 700; letter-spacing: .16em; }
.pairing-onboarding { width: min(920px, 100%); min-height: 100%; padding: 12px 0 26px; margin: 0 auto; }
.pairing-intro { display: flex; align-items: center; gap: 18px; margin: 0 auto 18px; }
.pairing-intro > img { width: 108px; height: 116px; object-fit: contain; object-position: bottom; filter: drop-shadow(0 12px 18px rgb(0 0 0 / .28)); }
.pairing-intro h1 { margin: 5px 0 6px; font-size: clamp(23px, 3vw, 32px); letter-spacing: -.03em; }
.pairing-intro p { max-width: 620px; margin: 0; color: var(--c-text-2); font: 13px/1.65 var(--font-reading); }
.pairing-layout { display: grid; grid-template-columns: minmax(0, 1.18fr) minmax(260px, .82fr); gap: 14px; align-items: start; }
.pairing-guide { background: rgb(14 18 32 / .9); border: 1px solid var(--c-line); border-radius: 15px; }
.pairing-method-divider { display: flex; align-items: center; gap: 9px; color: var(--c-text-3); font-size: var(--alu-micro-size); }
.pairing-method-divider::before, .pairing-method-divider::after { height: 1px; flex: 1; content: ''; background: var(--c-line-soft); }
.pairing-guide { padding: 9px 15px; margin: 0; list-style: none; }
.pairing-guide li { display: flex; gap: 11px; padding: 13px 2px; }
.pairing-guide li + li { border-top: 1px solid var(--c-line-soft); }
.pairing-guide li > span { display: grid; flex: 0 0 auto; width: 25px; height: 25px; color: var(--c-pink); font-weight: 700; background: rgb(244 114 182 / .09); border: 1px solid rgb(244 114 182 / .2); border-radius: 50%; place-items: center; }
.pairing-guide strong { font-size: var(--alu-meta-size); }
.pairing-guide p { margin: 5px 0 0; color: var(--c-text-3); font: var(--alu-meta-size)/1.55 var(--font-reading); }
@media (max-width: 1000px) {
  .pairing-onboarding {
    width: min(100%, 760px);
    min-height: auto;
    margin-inline: auto;
    padding: 8px 0 28px;
  }
  .pairing-intro {
    gap: 14px;
    margin: 0 0 16px;
  }
  .pairing-intro > img {
    width: 76px;
    height: 82px;
    flex: 0 0 auto;
  }
  .pairing-intro h1 {
    margin: 4px 0 5px;
    font-size: 25px;
  }
  .pairing-intro p { font-size: var(--alu-ui-size); line-height: 1.6; }
  .pairing-layout {
    display: grid;
    width: 100%;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .pairing-layout > * {
    position: relative;
    width: 100%;
    min-width: 0;
  }
  .pairing-guide {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    padding: 8px;
  }
  .pairing-guide li { min-width: 0; padding: 11px; }
  .pairing-guide li + li {
    border-top: 0;
    border-left: 1px solid var(--c-line-soft);
  }
}
@media (max-width: 640px) {
  .pairing-intro {
    align-items: flex-start;
    gap: 10px;
  }
  .pairing-intro > img {
    width: 60px;
    height: 68px;
  }
  .pairing-intro h1 { font-size: 21px; }
  .pairing-intro p { font-size: var(--alu-meta-size); }
  .pairing-guide {
    display: block;
    padding: 5px 13px;
  }
  .pairing-guide li { padding: 12px 2px; }
  .pairing-guide li + li {
    border-top: 1px solid var(--c-line-soft);
    border-left: 0;
  }
}
</style>
