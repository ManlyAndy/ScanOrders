// ===========================================================
// Логика страницы логиста: вход, разбор PDF, отправка маршрута
// ===========================================================

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let parsedNumbers = [];

function getBusinessDayKey(date = new Date()) {
  const d = new Date(date);
  if (d.getHours() < 7) d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function logout(){
  ["collected_session","collected_user","collected_expires_at"].forEach(k=>localStorage.removeItem(k));
  document.getElementById("screen-main").style.display="none";
  document.getElementById("screen-login").style.display="block";
}

function getSavedAuth(){
  const token=localStorage.getItem("collected_session");
  const expires=Number(localStorage.getItem("collected_expires_at")||0);
  if(!token||!expires||expires<=Date.now()){ logout(); return null; }
  return token;
}

function getSavedUser(){ return localStorage.getItem("collected_user")||""; }

window.addEventListener("load",()=>{
  document.getElementById("route-date").valueAsDate=new Date();
  if(getSavedAuth()){
    document.getElementById("screen-login").style.display="none";
    document.getElementById("screen-main").style.display="block";
  }
});

async function doLogin(){
  const login=document.getElementById("login-user").value.trim();
  const pass=document.getElementById("login-pass").value;
  const errEl=document.getElementById("login-error");
  errEl.textContent="";
  if(!login||!pass){errEl.textContent="Заполните логин и пароль";return;}
  const authHeader="Basic "+btoa(unescape(encodeURIComponent(login+":"+pass)));
  try{
    const res=await fetch(`${CONFIG.PROXY_URL}/login`,{method:"POST",headers:{Authorization:authHeader},cache:"no-store"});
    const data=await res.json().catch(()=>({}));
    if(res.status===401){errEl.textContent=data.error||"Неверный логин или пароль";return;}
    if(res.status===403){errEl.textContent=data.error||"Доступ к приложению запрещён";return;}
    if(!res.ok||!data.token){errEl.textContent=data.error||"Не удалось связаться с сервером";return;}
    localStorage.setItem("collected_session",data.token);
    localStorage.setItem("collected_user",login);
    localStorage.setItem("collected_expires_at",String(Date.now()+Number(data.expiresIn||0)*1000));
    document.getElementById("login-pass").value="";
    document.getElementById("screen-login").style.display="none";
    document.getElementById("screen-main").style.display="block";
  }catch(e){errEl.textContent="Нет соединения с прокси";}
}

