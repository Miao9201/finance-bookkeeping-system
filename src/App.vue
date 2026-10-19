<script setup>
import { computed, onMounted, ref } from 'vue';
import Dashboard from './Dashboard.vue';
import BusinessViews from './BusinessViews.vue';
import AccountingViews from './AccountingViews.vue';

const groups = [
  { label: '工作空间', items: [ ['dashboard','工作台','grid'], ['customers','客户管理','users'], ['contracts','代账合同','file'], ['tasks','月度任务','checklist'], ['bills','票据管理','ticket'], ['receivables','应收收款','wallet'] ] },
  { label: '财务核算', items: [ ['accounts','账套设置','building'], ['vouchers','凭证管理','receipt'], ['ledgers','账簿查询','book'], ['financial','财务报表','chart'], ['closing','期末处理','calendar'] ] },
  { label: '经营管理', items: [ ['reports','业务汇总','pie'], ['maintenance','数据维护','database'] ] },
];
const icons = {
  grid: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m11 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 0v6h6M8 13h8m-8 4h5',
  checklist: 'M9 5h11M9 12h11M9 19h11M3 5l1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2',
  ticket: 'M3 4h18v6a2 2 0 0 0 0 4v6H3v-6a2 2 0 0 0 0-4zm13 0v3m0 3v4m0 3v3',
  wallet: 'M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v12H5a3 3 0 0 1-3-3V6m19 7h-5v4h5m-3-2h.01',
  building: 'M4 21V4h12v17m0-12h4v12M2 21h20M8 8h4m-4 4h4m-4 4h4',
  receipt: 'M4 3h16v18l-4-2-4 2-4-2-4 2zm4 5h8m-8 4h8m-8 4h4',
  book: 'M12 5v16M2 3h6a4 4 0 0 1 4 2 4 4 0 0 1 4-2h6v17h-6a4 4 0 0 0-4 1 4 4 0 0 0-4-1H2z',
  chart: 'M3 3v18h18M7 15v2m5-7v7m5-12v12',
  calendar: 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2m3 11 3 3 5-5',
  pie: 'M21 12a9 9 0 1 1-9-9v9zm-5-10v6h6a9 9 0 0 0-6-6',
  database: 'M21 5c0 2-4 3-9 3S3 7 3 5s4-3 9-3 9 1 9 3m0 0v14c0 2-4 3-9 3s-9-1-9-3V5m0 7c0 2 4 3 9 3s9-1 9-3',
  plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-5-5 5 5-5 5', chevron: 'm9 5 7 7-7 7', down: 'm6 9 6 6 6-6',
  check: 'm5 12 4 4L19 6', clock: 'M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12h4',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6zm-4 10 3 3 5-6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', search: 'm21 21-5-5m2-6a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  close: 'm6 6 12 12M6 18 18 6', trend: 'm3 17 6-6 4 4 8-10m-6 0h6v6',
};
const allowed = groups.flatMap(g => g.items.map(i => i[0]));
const saved = localStorage.getItem('yundaizhang-page');
const page = ref(allowed.includes(saved) ? saved : 'dashboard');
const filter = ref({});
const state = ref(null);
const loading = ref(true);
const error = ref('');
const toast = ref('');
const showDemo = ref(false);
const demoLoading = ref(false);
const mobileNav = ref(false);
let toastTimer;
const currentTitle = computed(() => groups.flatMap(g => g.items).find(i => i[0] === page.value)?.[1] || '工作台');
const accountingPage = computed(() => ['accounts','vouchers','ledgers','financial','closing'].includes(page.value));
const dateLabel = new Intl.DateTimeFormat('zh-CN', {year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date());
function navigate(next, nextFilter = {}) {
  if (!allowed.includes(next)) return;
  page.value = next; filter.value = nextFilter || {}; mobileNav.value = false;
  localStorage.setItem('yundaizhang-page', next);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function notify(message) {
  if (!message || typeof message !== 'string') return;
  toast.value = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.value = '', 3200);
}
async function reload(message) {
  error.value = ''; loading.value = !state.value;
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(result.message || '数据加载失败');
    state.value = result.data;
    notify(message);
  } catch (err) { error.value = err.message || '无法连接本地服务，请检查程序是否正在运行。'; }
  finally { loading.value = false; }
}
async function loadDemo() {
  demoLoading.value = true;
  try {
    const response = await fetch('/api/demo', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(result.message || '示例数据导入失败');
    showDemo.value = false; await reload('虚构示例已载入，可以开始体验。');
  } catch (err) { notify(err.message); }
  finally { demoLoading.value = false; }
}
onMounted(reload);
</script>

<template>
  <svg class="svg-sprite" aria-hidden="true"><defs><symbol v-for="(path, name) in icons" :id="`icon-${name}`" :key="name" viewBox="0 0 24 24"><path :d="path" /></symbol></defs></svg>
  <div class="app-shell">
    <header class="topbar">
      <button class="brand" @click="navigate('dashboard')" aria-label="财务代账系统工作台">
        <span class="brand-mark"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M9 23h14a6 6 0 0 0 .3-12A8 8 0 0 0 8 9.8 6.6 6.6 0 0 0 9 23Z" fill="white"/><path d="m12 17 3 3 6-7" stroke="#2468ed" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="brand-name">财务代账系统</span><span class="edition">本地版</span>
      </button>
      <div class="topbar-context"><span class="topbar-divider"></span><span>让代账工作，井然有序</span></div>
      <div class="topbar-right"><span class="local-status"><i></i> 数据保存在本机</span><button class="topbar-backup" @click="navigate('maintenance')"><svg class="icon"><use href="#icon-shield"/></svg><span>备份与恢复</span></button><span class="topbar-divider"></span><div class="user-avatar" aria-label="本地管理员">管</div><span class="user-name">管理员</span><button class="mobile-menu" @click="mobileNav = !mobileNav" aria-label="展开导航"><svg class="icon"><use href="#icon-checklist"/></svg></button></div>
    </header>
    <aside class="sidebar" :class="{'is-open': mobileNav}" aria-label="主导航">
      <div class="workspace-label"><span class="workspace-icon">财</span><span>我的代账工作室<small>LOCAL WORKSPACE</small></span></div>
      <nav><div v-for="group in groups" :key="group.label" class="nav-group"><div class="nav-group-label">{{ group.label }}</div><button v-for="item in group.items" :key="item[0]" class="nav-item" :class="{active: page === item[0]}" :aria-current="page === item[0] ? 'page' : undefined" @click="navigate(item[0])"><svg class="icon"><use :href="`#icon-${item[2]}`"/></svg><span>{{ item[1] }}</span><span v-if="item[0] === 'tasks' && state?.dashboard?.overdue_task_count" class="nav-count">{{ state.dashboard.overdue_task_count }}</span></button></div></nav>
      <div class="sidebar-bottom"><div class="future-chip"><span class="future-dots">● ●</span><span>多人协作</span><small>后续功能</small></div><div class="sidebar-footnote"><i></i> 本地服务 · 安心记账</div></div>
    </aside>
    <main class="main-content">
      <div class="breadcrumb"><span>工作空间</span><svg class="icon"><use href="#icon-chevron"/></svg><span>{{ currentTitle }}</span><span class="breadcrumb-date">{{ dateLabel }}</span></div>
      <div v-if="error" class="notice danger-notice" role="alert"><div><strong>暂时无法读取数据</strong><div>{{ error }}</div></div><button class="btn btn-secondary" @click="reload()">重新连接</button></div>
      <div v-if="loading" class="loading-panel"><span class="spinner"></span><p>正在读取本地账务数据…</p></div>
      <template v-else-if="state">
        <Dashboard v-if="page === 'dashboard'" :state="state" @navigate="navigate" @demo="showDemo = true" />
        <AccountingViews v-else-if="accountingPage" :page="page" :state="state" :filter="filter" @changed="reload" @navigate="navigate" />
        <BusinessViews v-else :key="page" :page="page" :state="state" :filter="filter" @changed="reload" @navigate="navigate" />
      </template>
      <footer class="main-footer"><span>财务代账系统</span><span>专注每一笔账，照顾每一位客户。</span></footer>
    </main>
    <div v-if="toast" class="toast" role="status"><svg class="icon"><use href="#icon-bell"/></svg>{{ toast }}</div>
    <div v-if="showDemo" class="modal-mask" @click.self="showDemo = false"><section class="modal modal-small" role="dialog" aria-modal="true" aria-labelledby="demo-title"><div class="modal-header"><h2 id="demo-title">载入虚构示例数据</h2><button class="icon-button" @click="showDemo = false" aria-label="关闭"><svg class="icon"><use href="#icon-close"/></svg></button></div><div class="modal-body"><p>将添加虚构客户、合同及账务记录，帮助你体验完整流程。所有公司与金额仅用于演示。</p><div class="notice">已有业务数据时，系统会阻止导入，确保你的记录安全。</div></div><div class="modal-footer"><button class="btn btn-secondary" @click="showDemo = false">暂不载入</button><button class="btn btn-primary" :disabled="demoLoading" @click="loadDemo">{{ demoLoading ? '正在载入…' : '载入示例' }}</button></div></section></div>
  </div>
</template>
