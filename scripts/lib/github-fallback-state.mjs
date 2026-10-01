export function fallbackSourceFailure(item){
  const state=item?.sourceState;
  const messages=[state?.error,...(state?.errors||[]).map(x=>x.error)].filter(Boolean);
  const statuses=messages.flatMap(text=>[...String(text).matchAll(/HTTP (\d{3})\b/g)].map(x=>Number(x[1])));
  return {state:state?.status||null,messages,httpStatuses:[...new Set(statuses)],blocked:statuses.some(x=>[401,403,429].includes(x))};
}
