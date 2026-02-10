export function wireWhyModal(){
  const modal=document.getElementById("whyModal");
  const btn=document.getElementById("whyBtn");
  const close=document.getElementById("whyClose");
  if(!modal||!btn||!close) return;
  const open=()=>{modal.style.display="flex";};
  const hide=()=>{modal.style.display="none";};
  btn.addEventListener("click",open);
  close.addEventListener("click",hide);
  modal.addEventListener("click",(e)=>{if(e.target===modal) hide();});
  window.addEventListener("keydown",(e)=>{if(e.key==="Escape") hide();});
}
export function showToast(text,ms=1400){
  const t=document.getElementById("toast");
  if(!t) return;
  t.textContent=text;
  t.style.display="block";
  clearTimeout(t._to);
  t._to=setTimeout(()=>{t.style.display="none";},ms);
}
