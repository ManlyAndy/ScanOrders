let scanner = null;
let currentOrder = null;
let groupOrders = [];
let photoFiles = [];
let photoBusy = false;

function $(id){return document.getElementById(id)}
function esc(v){const d=document.createElement("div");d.textContent=v==null?"":String(v);return d.innerHTML}
function sessionExpiresAt(){return Number(localStorage.getItem("collected_expires_at")||0)}
function sessionIsValid(){return !!auth()&&sessionExpiresAt()>Date.now()}
function auth(){return localStorage.getItem("collected_session")}
function user(){return localStorage.getItem("collected_user")||""}
function show(name){["login","scan","result"].forEach(x=>$(`screen-${x}`).classList.remove("active"));$(`screen-${name}`).classList.add("active")}
function stopScanner(){if(scanner){try{scanner.stop().catch(()=>{})}catch(e){}scanner=null}}
function startScanner(){stopScanner();$("reader").innerHTML="";scanner=new Html5Qrcode("reader");Html5Qrcode.getCameras().then(cameras=>{if(!cameras.length){$("reader").innerHTML='<p class="error">Камера не найдена.</p>';return}const cam=cameras.find(c=>/back|rear|environment/i.test(c.label))||cameras[0];scanner.start(cam.id,{fps:10,qrbox:{width:270,height:150},formatsToSupport:[Html5QrcodeSupportedFormats.CODE_128]},text=>{stopScanner();lookup(text.trim())},()=>{}).catch(()=>{$("reader").innerHTML='<p class="error">Не удалось открыть камеру. Разрешите доступ к камере.</p><button class="btn-secondary" onclick="startScanner()">Повторить</button>'})}).catch(()=>{$("reader").innerHTML='<p class="error">Нет доступа к камере.</p>'})}
function enterScan(){$("who-label").textContent=user();$("who-label-2").textContent=user();show("scan");setTimeout(startScanner,250)}
function showManual(){$("manual").classList.toggle("hidden")}
function manualLookup(){const v=$("manual-code").value.trim();if(v){stopScanner();lookup(v)}}
function backToScan(){$("manual").classList.add("hidden");$("manual-code").value="";show("scan");setTimeout(startScanner,150)}
async function doLogin(){
  const login=$("login-user").value.trim(),pass=$("login-pass").value,err=$("login-error");
  err.textContent="";
  if(!login||!pass){err.textContent="Заполните логин и пароль";return}
  const h="Basic "+btoa(unescape(encodeURIComponent(login+":"+pass)));
  try{
    const r=await fetch(`${CONFIG.PROXY_URL}/login`,{method:"POST",headers:{Authorization:h},cache:"no-store"});
    const d=await r.json().catch(()=>({}));
    if(r.status===401){err.textContent=d.error||"Неверный логин или пароль";return}
    if(r.status===403){err.textContent=d.error||"Доступ к приложению запрещён";return}
    if(!r.ok||!d.token){err.textContent=d.error||"Не удалось связаться с сервером";return}
    localStorage.setItem("collected_session",d.token);
    localStorage.setItem("collected_user",login);
    localStorage.setItem("collected_expires_at",String(d.expiresAt||Date.now()+Number(d.expiresIn||0)*1000));
    $("login-pass").value="";
    enterScan();
  }catch(e){err.textContent="Нет соединения с сервером"}
}
function logout(){
  ["collected_session","collected_user","collected_expires_at"].forEach(k=>localStorage.removeItem(k));
  stopScanner();currentOrder=null;groupOrders=[];show("login");
}

async function lookup(code){show("result");$("result-body").innerHTML='<div class="spinner"></div><p class="hint" style="text-align:center">Ищу отгрузку '+esc(code)+'…</p>';try{const r=await fetch(`${CONFIG.PROXY_URL}/find?code=${encodeURIComponent(code)}&_=${Date.now()}`,{headers:{Authorization:"Bearer "+auth()},cache:"no-store"});if(r.status===401){logout();return}const d=await r.json();if(!d.found){renderNotFound(code);return}currentOrder=d;if(d.alreadyCollected){renderCollected(d);return}if(!d.collectable){renderWrongStatus(d);return}if(groupOrders.some(x=>String(x.id)===String(d.id))){renderDuplicate(d);return}groupOrders.push(d);renderGroup()}catch(e){$("result-body").innerHTML='<div class="card bad"><div class="badge bad">ОШИБКА</div><p>Не удалось связаться с сервером.</p></div>'}}
function renderNotFound(code){$("result-body").innerHTML=`<div class="card bad"><div class="badge bad">НЕ НАЙДЕНО</div><div class="num">№ ${esc(code)}</div><p class="meta">Отгрузка с таким номером не найдена.</p></div>`}
function renderWrongStatus(d){$("result-body").innerHTML=`<div class="card bad"><div class="badge bad">НЕ ГОТОВО</div><div class="num">№ ${esc(d.name)}</div><div class="meta">Покупатель: <b>${esc(d.agentName)}</b></div><div class="meta">Текущий статус: <b>${esc(d.stateName||"—")}</b></div><p class="meta">Для этого приложения допустимы статусы «${esc(CONFIG.STATUS_NOT_COLLECTED_NAME)}» и «${esc(CONFIG.STATUS_URGENT_NAME)}».</p>${groupOrders.length?'<button class="btn-secondary" onclick="renderGroup()">Вернуться к упаковке</button>':''}`}
function pickersLabel(p1,p2){if(!p1)return "—";return p2?`${p1}, ${p2}`:p1}
function renderCollected(d){$("result-body").innerHTML=`<div class="card ok"><div class="badge ok">УЖЕ СОБРАНО ✓</div><div class="num">№ ${esc(d.name)}</div><div class="meta">Покупатель: <b>${esc(d.agentName)}</b></div><div class="meta">Сборщик(и): <b>${esc(pickersLabel(d.pickerName1,d.pickerName2))}</b></div><div class="meta">Количество мест: <b>${esc(d.places==null?"—":d.places)}</b></div></div>${groupOrders.length?'<button class="btn-secondary" onclick="renderGroup()">Вернуться к упаковке</button>':''}`}
function renderDuplicate(d){$("result-body").innerHTML=`<div class="card bad"><div class="badge bad">УЖЕ ДОБАВЛЕНА</div><div class="num">№ ${esc(d.name)}</div><p class="meta">Эта отгрузка уже находится в текущей упаковке.</p></div><button class="btn-success" onclick="renderGroup()">Вернуться к упаковке</button>`}
function pickerChips(selected,targetId){return CONFIG.PICKER_NAMES.map(n=>`<button type="button" class="chip${n===selected?" chip-active":""}" onclick="selectPicker('${esc(n).replace(/'/g,"\\'")}','${targetId}')">${esc(n)}</button>`).join("")}
function selectPicker(name,targetId){$(targetId).value=name;document.querySelectorAll(`#${targetId}-chips .chip`).forEach(c=>c.classList.toggle("chip-active",c.textContent===name))}
function renderGroup(){if(!groupOrders.length){backToScan();return}const rows=groupOrders.map((d,i)=>`<div class="group-row"><div><div class="group-num">№ ${esc(d.name)}</div><div class="group-agent">${esc(d.agentName||"—")}</div></div><button class="remove-order" onclick="removeFromGroup(${i})" title="Убрать">×</button></div>`).join("");$("result-body").innerHTML=`<div class="card ok"><div class="badge ok">УПАКОВКА · ${groupOrders.length} ${groupOrders.length===1?"ОТГРУЗКА":"ОТГРУЗКИ"}</div><div class="group-list">${rows}</div></div><button class="btn-primary add-order-btn" onclick="addOrderToGroup()">＋ Добавить отгрузку</button><button class="btn-success" onclick="openCollectModal()">Сменить статус всех</button><button class="btn-secondary" onclick="openPhotoModal()">Сделать фото</button><button class="link-btn" onclick="cancelGroup()">Отменить упаковку</button>`}
function addOrderToGroup(){$("manual").classList.add("hidden");show("scan");setTimeout(startScanner,150)}
function removeFromGroup(index){if(index<0||index>=groupOrders.length)return;groupOrders.splice(index,1);if(groupOrders.length)renderGroup();else backToScan()}
function cancelGroup(){if(!confirm("Удалить все отгрузки из текущей упаковки?"))return;groupOrders=[];currentOrder=null;backToScan()}

function openCollectModal(){if(!groupOrders.length)return;const first=groupOrders[0];const p1=first.pickerName1||"",p2=first.pickerName2||"",places=first.places==null?"":first.places;$("order-content").innerHTML=`<div class="num">Упаковка · ${groupOrders.length} ${groupOrders.length===1?"отгрузка":"отгрузки"}</div><div class="group-mini">${groupOrders.map(d=>`№ ${esc(d.name)}`).join(" · ")}</div><p class="meta">Эти значения будут записаны во все отгрузки упаковки.</p><label class="hint">Сборщик №1</label><input id="picker-input-1" type="text" placeholder="Впишите имя или выберите ниже" value="${esc(p1)}" autocomplete="off"><div id="picker-input-1-chips" class="chips">${pickerChips(p1,"picker-input-1")}</div><label class="hint">Сборщик №2 (необязательно)</label><input id="picker-input-2" type="text" placeholder="Впишите имя или выберите ниже" value="${esc(p2)}" autocomplete="off"><div id="picker-input-2-chips" class="chips">${pickerChips(p2,"picker-input-2")}</div><label class="hint">Количество мест</label><input id="places-input" type="number" min="1" step="1" inputmode="numeric" value="${esc(places)}" placeholder="Количество мест"><button class="btn-success" onclick="collectGroup()">Сменить статус всех</button>`;$("order-modal").classList.add("active")}
function closeOrderModal(){$("order-modal").classList.remove("active")}
async function collectGroup(){if(!groupOrders.length)return;const picker1=$("picker-input-1").value.trim(),picker2=$("picker-input-2").value.trim(),places=Number($("places-input").value);if(!picker1){alert("Впишите имя сборщика №1");return}if(!Number.isInteger(places)||places<1){alert("Укажите количество мест");return}const btn=document.querySelector("#order-content .btn-success");btn.disabled=true;btn.textContent="Сохраняю…";try{const r=await fetch(`${CONFIG.PROXY_URL}/collect-group`,{method:"POST",headers:{"Authorization":"Bearer "+auth(),"Content-Type":"application/json"},body:JSON.stringify({items:groupOrders.map(d=>({id:d.id,name:d.name})),picker1,picker2,places})});if(r.status===401){logout();return}const d=await r.json();if(!d.ok){alert(d.error||"Не удалось изменить статус");btn.disabled=false;btn.textContent="Сменить статус всех";return}groupOrders=groupOrders.map(order=>({...order,stateName:CONFIG.STATUS_COLLECTED_NAME,alreadyCollected:true,pickerName1:picker1,pickerName2:picker2||null,places}));currentOrder=groupOrders[groupOrders.length-1];closeOrderModal();$("result-body").innerHTML=`<div class="card ok"><div class="badge ok">СОБРАНО ✓</div><div class="num">${groupOrders.length} ${groupOrders.length===1?"отгрузка":"отгрузки"}</div><div class="group-mini">${groupOrders.map(d=>`№ ${esc(d.name)}`).join(" · ")}</div><div class="meta">Сборщик(и): <b>${esc(pickersLabel(picker1,picker2))}</b></div><div class="meta">Количество мест: <b>${places}</b></div><p class="meta">Статус успешно изменён в МойСклад для всех отгрузок.</p></div><button class="btn-secondary" onclick="openPhotoModal()">Сделать фото</button><button class="btn-primary" onclick="finishPackage()">Готово</button>`}catch(e){alert("Нет соединения с сервером")}finally{btn.disabled=false;btn.textContent="Сменить статус всех"}}
function finishPackage(){groupOrders=[];currentOrder=null;backToScan()}

function openPhotoModal(){if(!groupOrders.length)return;photoFiles=[];$("photo-title").textContent=groupOrders.length===1?`Фото отгрузки № ${groupOrders[0].name}`:`Фото упаковки · ${groupOrders.length} отгрузки`;$('photo-numbers').textContent=groupOrders.map(d=>`№ ${d.name}`).join(" · ");$("photo-status").textContent="";$("photo-input-camera").value="";$("photo-input-gallery").value="";renderPhotoGrid();$("photo-modal").classList.add("active")}
function closePhotoModal(){$("photo-modal").classList.remove("active")}
function openCamera(){$("photo-input-camera").click()}
function openGallery(){$("photo-input-gallery").click()}
function addAnotherPhoto(){$("photo-input-camera").click()}
function handlePhotoFiles(files){[...files].forEach(f=>{if(f.type.startsWith("image/"))photoFiles.push(f)});$("photo-input-camera").value="";$("photo-input-gallery").value="";renderPhotoGrid()}
function renderPhotoGrid(){const grid=$("photo-grid");grid.innerHTML="";photoFiles.forEach((file,i)=>{const url=URL.createObjectURL(file);const div=document.createElement("div");div.className="photo-item";div.innerHTML=`<img src="${url}"><button class="btn-danger photo-remove" onclick="removePhoto(${i})">×</button>`;grid.appendChild(div)})}
function removePhoto(i){photoFiles.splice(i,1);renderPhotoGrid()}
async function compressPhoto(file){return new Promise((resolve,reject)=>{const img=new Image(),url=URL.createObjectURL(file);img.onload=()=>{const max=1600,scale=Math.min(1,max/Math.max(img.width,img.height));const c=document.createElement("canvas");c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);c.getContext("2d").drawImage(img,0,0,c.width,c.height);c.toBlob(b=>{URL.revokeObjectURL(url);b?resolve(b):reject(new Error("compress"))},"image/jpeg",.82)};img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("image"))};img.src=url})}
function blobToBase64(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(",")[1]);r.onerror=reject;r.readAsDataURL(blob)})}
async function uploadPhotos(){if(!photoFiles.length){alert("Сначала сделайте хотя бы одно фото");return}if(photoBusy)return;photoBusy=true;$("photo-status").textContent="Загружаю фото в Битрикс24…";try{const photos=[];for(const f of photoFiles){const b=await compressPhoto(f);photos.push({name:f.name.replace(/\.[^.]+$/,"" )+".jpg",content:await blobToBase64(b)})}const r=await fetch(`${CONFIG.PROXY_URL}/photo/upload`,{method:"POST",headers:{"Authorization":"Bearer "+auth(),"Content-Type":"application/json"},body:JSON.stringify({numbers:groupOrders.map(d=>d.name),photos,by:user()})});if(r.status===401){logout();return}const d=await r.json();if(!d.ok)throw new Error(d.error||"upload");$("photo-status").textContent=`Загружено: ${d.uploaded} фото`;setTimeout(closePhotoModal,700)}catch(e){$("photo-status").textContent="Не удалось загрузить фото. Проверьте настройки Bitrix24."}finally{photoBusy=false}}
window.addEventListener("load",()=>{if(sessionIsValid()){enterScan();setTimeout(()=>{if(!sessionIsValid())logout()},Math.max(0,sessionExpiresAt()-Date.now()+250))}else logout()})
