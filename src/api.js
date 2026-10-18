export async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch('/api' + path, { method, ...(data === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)}) });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(result.message || '操作失败，请重试');
  return result.data;
}
export function units(value) {
  const n=BigInt(Math.trunc(Number(value||0))),abs=n<0n?-n:n;
  return `${n<0n?'-':''}${abs/100n}.${String(abs%100n).padStart(2,'0')}`;
}
export function yuan(value) {
  const [integer,fraction]=units(value).split('.');
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+fraction;
}
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
export function cents(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('金额须为非负数，最多两位小数');
  const [a,b=''] = s.split('.'); const n = Number(a)*100 + Number(b.padEnd(2,'0'));
  if (!Number.isSafeInteger(n)) throw new Error('金额过大');
  return n;
}
export function fileBase64(file) {
  return new Promise((resolve,reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = () => reject(new Error('文件读取失败')); r.readAsDataURL(file); });
}
