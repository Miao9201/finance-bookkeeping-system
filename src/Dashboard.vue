<script setup>
import { computed, ref } from 'vue';
import { yuan } from './api.js';
const props = defineProps({ state: {type:Object,required:true} });
const emit = defineEmits(['navigate','demo']);
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
const month = ref(today.slice(0,7));
const money = value => yuan(value);
const compactMoney = value => Math.abs(value) >= 1000000 ? `${(value/1000000).toFixed(1)}万` : money(value);
const customers = computed(() => props.state.customers || []);
const customerName = id => customers.value.find(c => c.id === id)?.name || '未关联客户';
const taskMonth = task => task.period || task.month || (task.due_date || task.date || '').slice(0,7);
const receivableMonth = row => row.period || row.month || (row.due_date || row.date || '').slice(0,7);
const paymentMonth = row => (row.payment_date || row.date || row.paid_at || '').slice(0,7);
const steps = [ {key:'collect',label:'票据收集',icon:'ticket'}, {key:'sort',label:'票据整理',icon:'file'}, {key:'book',label:'记账处理',icon:'book'}, {key:'review',label:'凭证复核',icon:'shield'}, {key:'tax',label:'申报准备',icon:'checklist'} ];
const taskStatus = (task, key) => Array.isArray(task.steps) ? task.steps.find(step => step.key === key)?.status || '未开始' : task.steps?.[key]?.status || task.steps?.[key] || '未开始';
const complete = task => task.status === '已完成' || steps.every(step => taskStatus(task, step.key) === '已完成');
const periodTasks = computed(() => (props.state.tasks || []).filter(t => taskMonth(t) === month.value));
const pendingTasks = computed(() => periodTasks.value.filter(t => !complete(t)));
const periodReceivables = computed(() => (props.state.receivables || []).filter(r => receivableMonth(r) === month.value));
const receivableTotal = computed(() => periodReceivables.value.reduce((sum,r) => sum+Number(r.amount_cents || 0),0));
const receivedTotal = computed(() => (props.state.payments || []).filter(p => paymentMonth(p) === month.value).reduce((sum,p) => sum+Number(p.amount_cents || 0),0));
const outstanding = computed(() => (props.state.receivables || []).reduce((sum,r) => sum+Number(r.balance_cents ?? ((r.amount_cents||0)-(r.received_cents||0))),0));
const overdue = computed(() => (props.state.receivables || []).filter(r => r.due_date && r.due_date < today && Number(r.balance_cents ?? ((r.amount_cents||0)-(r.received_cents||0)))>0));
const overdueTotal = computed(() => overdue.value.reduce((sum,r) => sum+Number(r.balance_cents ?? ((r.amount_cents||0)-(r.received_cents||0))),0));
const lateTasks = computed(() => pendingTasks.value.filter(t => t.due_date && t.due_date < today));
const activeCustomers = computed(() => customers.value.filter(c => c.status === '服务中').length);
const contracts = computed(() => props.state.contracts || []);
const activeContracts = computed(() => contracts.value.filter(c => c.status === '执行中'));
const expirationLimit = new Date(now.getFullYear(),now.getMonth(),now.getDate()+30);
const expirationDate = `${expirationLimit.getFullYear()}-${String(expirationLimit.getMonth()+1).padStart(2,'0')}-${String(expirationLimit.getDate()).padStart(2,'0')}`;
const expiringContracts = computed(() => activeContracts.value.filter(c => c.end_date >= today && c.end_date <= expirationDate));
const expiredContracts = computed(() => contracts.value.filter(c => c.status === '已到期' || (c.status === '执行中' && c.end_date < today)));
const completionPercent = computed(() => periodTasks.value.length ? Math.round((periodTasks.value.length-pendingTasks.value.length)/periodTasks.value.length*100) : 0);
const progress = computed(() => steps.map(s => ({...s,done:periodTasks.value.filter(t => taskStatus(t,s.key)==='已完成').length, total:periodTasks.value.length})));
const recentTasks = computed(() => [...pendingTasks.value].sort((a,b)=>(a.due_date||'9999').localeCompare(b.due_date||'9999')).slice(0,5));
const trend = computed(() => {
  const [year, selected] = month.value.split('-').map(Number);
  return Array.from({length:6},(_,index) => {
    const date = new Date(year,selected-6+index,1);
    const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
    const rows = (props.state.receivables||[]).filter(r => receivableMonth(r) === key);
    return { key, label:`${date.getMonth()+1}月`, receivable:rows.reduce((sum,r)=>sum+Number(r.amount_cents||0),0), received:(props.state.payments||[]).filter(p=>paymentMonth(p)===key).reduce((sum,p)=>sum+Number(p.amount_cents||0),0) };
  });
});
const maxValue = computed(() => Math.max(...trend.value.flatMap(t=>[t.receivable,t.received]),10000)*1.2);
const chartPoint = (index,value) => [55+index*104,164-value/maxValue.value*132];
const linePath = key => trend.value.map((t,i)=>`${i?'L':'M'}${chartPoint(i,t[key]).join(',')}`).join(' ');
const fillPath = computed(() => `${linePath('received')} L575,164 L55,164 Z`);
const ticks = computed(() => [0,1,2,3].map(i=>({y:164-i*44,value:maxValue.value*i/3})));
const empty = computed(() => customers.value.length === 0 && (props.state.contracts||[]).length === 0);
function tasksFilter(extra = {}) { return { period:month.value, month:month.value, ...extra }; }
</script>

<template>
  <div class="dashboard">
    <div class="page-heading dashboard-heading"><div><div class="eyebrow">YOUR BUSINESS AT A GLANCE</div><h1 class="page-title">工作台<span class="heading-dot">.</span></h1><p class="page-description">每一份托付，都有条不紊。</p></div><div class="dashboard-heading-actions"><label class="month-picker"><svg class="icon"><use href="#icon-calendar"/></svg><input type="month" v-model="month" @change="month ||= today.slice(0,7)" min="1900-01" max="9999-12" required aria-label="工作台统计月份" /></label><button class="btn btn-primary" @click="emit('navigate','customers',{action:'new'})"><svg class="icon"><use href="#icon-plus"/></svg>新增客户</button></div></div>

    <div v-if="empty" class="welcome-banner"><div class="welcome-illustration"><svg class="icon"><use href="#icon-building"/></svg><span class="welcome-star">✦</span></div><div class="welcome-copy"><strong>从第一位客户，开始你的代账工作</strong><p>建立客户档案、签订合同，将每月的工作与收款串联起来。</p></div><button class="btn btn-secondary" @click="emit('demo')">体验虚构示例 <span>↗</span></button></div>
    <div class="stat-grid">
      <section class="stat-card"><div class="stat-label">服务客户<span class="stat-icon blue"><svg class="icon"><use href="#icon-users"/></svg></span></div><div class="stat-value">{{ activeCustomers }}<small>家</small></div><div class="stat-footer"><span><span class="status-dot blue"></span>客户档案 {{ customers.length }} 家</span><button class="text-link" @click="emit('navigate','customers')">查看客户 <span>↗</span></button></div></section>
      <section class="stat-card"><div class="stat-label">本月应收<span class="stat-icon purple"><svg class="icon"><use href="#icon-wallet"/></svg></span></div><div class="stat-value"><span class="currency">¥</span>{{ money(receivableTotal) }}</div><div class="stat-footer"><span>{{ periodReceivables.length }} 笔应收记录</span><button class="text-link" @click="emit('navigate','receivables',{month})">收款管理 <span>↗</span></button></div></section>
      <section class="stat-card"><div class="stat-label">本月实收<span class="stat-icon green"><svg class="icon"><use href="#icon-trend"/></svg></span></div><div class="stat-value"><span class="currency">¥</span>{{ money(receivedTotal) }}</div><div class="stat-footer"><span><span class="status-dot green"></span>按实际收款日期统计</span><button class="text-link" @click="emit('navigate','receivables')">查看记录 <span>↗</span></button></div></section>
      <section class="stat-card"><div class="stat-label">本月待办<span class="stat-icon orange"><svg class="icon"><use href="#icon-checklist"/></svg></span></div><div class="stat-value">{{ pendingTasks.length }}<small>项</small><span v-if="lateTasks.length" class="mini-alert">{{ lateTasks.length }} 项逾期</span></div><div class="stat-footer"><span>已完成 {{ periodTasks.length - pendingTasks.length }} / {{ periodTasks.length }} 项</span><button class="text-link" @click="emit('navigate','tasks',tasksFilter())">处理任务 <span>↗</span></button></div></section>
    </div>

    <div class="dashboard-middle">
      <section class="card task-progress-card"><div class="card-header"><div><h2>本月代账进度</h2><span class="card-subtitle">按客户月度任务汇总</span></div><button class="text-link muted-link" @click="emit('navigate','tasks',tasksFilter())">全部任务 <svg class="icon"><use href="#icon-chevron"/></svg></button></div><div class="progress-summary"><div class="ring-wrap"><svg viewBox="0 0 112 112" class="progress-ring"><circle class="ring-track" cx="56" cy="56" r="46"/><circle class="ring-fill" cx="56" cy="56" r="46" :stroke-dasharray="`${completionPercent*2.89} 289`"/></svg><div class="ring-content"><strong>{{ completionPercent }}<small>%</small></strong><span>任务完成率</span></div></div><div class="progress-summary-copy"><strong>{{ periodTasks.length - pendingTasks.length }}<span> / {{ periodTasks.length }} 项</span></strong><p>本月客户代账任务已完成</p><span class="subtle-pill"><span class="status-dot blue"></span>{{ month.replace('-',' 年 ') }} 月</span></div></div><div class="step-progress-list"><div v-for="step in progress" :key="step.key" class="step-progress-row"><span class="step-label"><svg class="icon"><use :href="`#icon-${step.icon}`"/></svg>{{ step.label }}</span><div class="progress-track"><span :style="{width:`${step.total ? step.done/step.total*100 : 0}%`}"></span></div><span class="step-count">{{ step.done }}<span> / {{ step.total }}</span></span></div></div></section>
      <section class="card trend-card"><div class="card-header"><div><h2>收款趋势</h2><span class="card-subtitle">近六个月应收与实收金额</span></div><div class="chart-legend"><span><i class="legend-blue"></i>应收</span><span><i class="legend-green"></i>实收</span></div></div><div class="trend-chart"><div class="chart-unit">单位：元</div><svg viewBox="0 0 620 205" role="img" :aria-label="`截至${month}的六个月应收和实收金额趋势`"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#36b99a" stop-opacity=".16"/><stop offset="100%" stop-color="#36b99a" stop-opacity="0"/></linearGradient></defs><g v-for="tick in ticks" :key="tick.y"><line x1="55" x2="590" :y1="tick.y" :y2="tick.y" stroke="#edf0f5" stroke-dasharray="3 4"/><text x="43" :y="tick.y+4" text-anchor="end" class="chart-axis">{{ compactMoney(tick.value).replace('.00','') }}</text></g><path :d="fillPath" fill="url(#chart-fill)"/><path :d="linePath('receivable')" fill="none" stroke="#4b81f0" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path :d="linePath('received')" fill="none" stroke="#31b293" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><g v-for="(point,index) in trend" :key="point.key"><circle :cx="chartPoint(index,point.receivable)[0]" :cy="chartPoint(index,point.receivable)[1]" r="3.5" fill="white" stroke="#4b81f0" stroke-width="2"><title>{{ point.key }} 应收 ¥{{ money(point.receivable) }}</title></circle><circle :cx="chartPoint(index,point.received)[0]" :cy="chartPoint(index,point.received)[1]" r="3.5" fill="white" stroke="#31b293" stroke-width="2"><title>{{ point.key }} 实收 ¥{{ money(point.received) }}</title></circle><text :x="chartPoint(index,0)[0]" y="193" text-anchor="middle" class="chart-axis">{{ point.label }}</text></g></svg></div><div class="trend-bottom"><span>待收款余额 <strong>¥{{ money(outstanding) }}</strong></span><span :class="{'overdue-text':overdueTotal>0}">其中逾期 <strong>¥{{ money(overdueTotal) }}</strong></span><button class="text-link" @click="emit('navigate','receivables')">查看明细 <span>↗</span></button></div></section>
    </div>

    <section class="card contract-overview"><div class="contract-overview-title"><span class="contract-symbol"><svg class="icon"><use href="#icon-file"/></svg></span><div><h2>合同服务概况</h2><span>让每一次合作，有始有续</span></div></div><button class="contract-metric" @click="emit('navigate','contracts')"><span>合同总数</span><strong>{{ contracts.length }}<small>份</small></strong></button><button class="contract-metric" @click="emit('navigate','contracts',{status:'执行中'})"><span>执行中</span><strong>{{ activeContracts.length }}<small>份</small></strong></button><button class="contract-metric" :class="{'needs-attention':expiringContracts.length}" @click="emit('navigate','contracts',{expiresSoon:true})"><span>30 天内到期</span><strong>{{ expiringContracts.length }}<small>份</small></strong></button><button class="contract-metric" :class="{'needs-attention':expiredContracts.length}" @click="emit('navigate','contracts',{expired:true})"><span>已到期待续签</span><strong>{{ expiredContracts.length }}<small>份</small></strong></button><button class="text-link" @click="emit('navigate','contracts')">管理合同 <svg class="icon"><use href="#icon-chevron"/></svg></button></section>

    <div class="dashboard-bottom">
      <section class="card pending-card"><div class="card-header"><div class="card-title-line"><h2>待办工作</h2><span class="count-tag">{{ pendingTasks.length }}</span></div><button class="text-link muted-link" @click="emit('navigate','tasks',tasksFilter())">查看全部 <svg class="icon"><use href="#icon-chevron"/></svg></button></div><div class="table-wrap"><table class="data-table dashboard-task-table"><thead><tr><th>客户 / 任务</th><th>所属月份</th><th>截止日期</th><th>任务进度</th><th>操作</th></tr></thead><tbody><tr v-for="task in recentTasks" :key="task.id"><td><strong class="table-customer-name">{{ task.customer_name || customerName(task.customer_id) }}</strong><div class="table-detail">{{ task.title || '月度代账服务' }}</div></td><td>{{ taskMonth(task) }}</td><td :class="{'overdue-text':task.due_date && task.due_date<today}">{{ task.due_date || '未设置' }}<span v-if="task.due_date && task.due_date<today" class="overdue-dot"></span></td><td><div class="task-mini-progress"><span v-for="step in steps" :key="step.key" :class="{'is-done':taskStatus(task,step.key)==='已完成','is-doing':taskStatus(task,step.key)==='进行中'}" :title="`${step.label}：${taskStatus(task,step.key)}`"></span><small>{{ steps.filter(s=>taskStatus(task,s.key)==='已完成').length }}/5</small></div></td><td><button class="text-link" @click="emit('navigate','tasks',tasksFilter({customer_id:task.customer_id,task_id:task.id}))">去处理 <span>→</span></button></td></tr><tr v-if="!recentTasks.length"><td colspan="5"><div class="empty-state compact"><span class="empty-icon"><svg class="icon"><use href="#icon-checklist"/></svg></span><strong>{{ periodTasks.length ? '本月工作已全部完成' : '本月还没有代账任务' }}</strong><p>{{ periodTasks.length ? '每一份认真，都让工作更从容。' : '从月度任务中生成本月工作清单。' }}</p><button class="text-link" @click="emit('navigate','tasks',tasksFilter())">前往月度任务 →</button></div></td></tr></tbody></table></div></section>
      <section class="card quick-card"><div class="card-header"><h2>快捷开始</h2><span class="card-subtitle">常用工作，一步直达</span></div><div class="quick-grid"><button @click="emit('navigate','customers',{action:'new'})"><span class="quick-icon blue"><svg class="icon"><use href="#icon-users"/></svg></span><strong>新增客户</strong><small>建立客户档案</small></button><button @click="emit('navigate','contracts',{action:'new'})"><span class="quick-icon purple"><svg class="icon"><use href="#icon-file"/></svg></span><strong>签订合同</strong><small>管理服务约定</small></button><button @click="emit('navigate','bills',{action:'new'})"><span class="quick-icon orange"><svg class="icon"><use href="#icon-ticket"/></svg></span><strong>登记票据</strong><small>归集原始凭据</small></button><button @click="emit('navigate','vouchers',{action:'new'})"><span class="quick-icon green"><svg class="icon"><use href="#icon-receipt"/></svg></span><strong>录入凭证</strong><small>记录每笔账务</small></button></div><div class="quick-tip"><svg class="icon"><use href="#icon-shield"/></svg><span>建议定期备份，让工作更安心。</span><button @click="emit('navigate','maintenance')" aria-label="前往数据备份">→</button></div></section>
    </div>
  </div>
</template>
