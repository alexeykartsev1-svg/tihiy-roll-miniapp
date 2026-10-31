(()=>{
'use strict';
const API='https://tihiy-roll-order-api.onrender.com';
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const SET_NAMES={newyear:'Новогодний сет',solo:'Сет «На одного»',duo:'Сет «Вечер вдвоём»',party:'Сет для компании'};
const state={products:[],sets:[],settings:{},cart:{},setCounts:{},favorites:new Set(),filter:'sets',sort:'popular',search:'',selected:null,detailQty:1,photos:[],photoIndex:0,toastTimer:0,builderFilter:'all',builderItems:{},builderSets:{},activeScreen:'catalogue',lastOrder:null};
const money=n=>Math.round(Number(n)||0).toLocaleString('ru-RU')+' ₽';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const apiGet=async path=>{const r=await fetch(API+path,{cache:'no-store'});if(!r.ok)throw Error('Сервер меню ответил '+r.status);return r.json();};
const tg=()=>window.Telegram?.WebApp||null;
const find=id=>state.products.find(p=>p.id===id);
const qty=id=>Number(state.cart[id]||0);
const stock=p=>p?.stock==null?null:Math.max(0,Number(p.stock)||0);
const photo=p=>p?.photo||'./assets/set-party.webp';
const productTotal=()=>state.products.reduce((sum,p)=>sum+p.price*qty(p.id),0);
const cartCount=()=>Object.values(state.cart).reduce((sum,n)=>sum+Number(n||0),0);
const setPrice=s=>(s.items||[]).reduce((sum,i)=>sum+(find(i.id)?.price||0)*Number(i.qty||0),0);
const setPieces=s=>(s.items||[]).reduce((sum,i)=>sum+(Number(find(i.id)?.pieces)||8)*Number(i.qty||0),0);
const setWeight=s=>(s.items||[]).reduce((sum,i)=>sum+(parseInt(find(i.id)?.weight,10)||0)*Number(i.qty||0),0);
function toast(msg){const n=$('#toast');n.textContent=msg;n.classList.add('show');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>n.classList.remove('show'),2600);}
function save(){try{localStorage.setItem('tihiy-stage1-cart',JSON.stringify(state.cart));localStorage.setItem('tihiy-stage1-fav',JSON.stringify(Array.from(state.favorites)));localStorage.setItem('tihiy-stage1-sets',JSON.stringify(state.setCounts));}catch(e){}}
function loadSaved(){try{state.cart=JSON.parse(localStorage.getItem('tihiy-stage1-cart')||'{}');state.favorites=new Set(JSON.parse(localStorage.getItem('tihiy-stage1-fav')||'[]'));state.setCounts=JSON.parse(localStorage.getItem('tihiy-stage1-sets')||'{}');}catch(e){}}
function setImage(s){const fixed={solo:'./assets/set-solo.webp',duo:'./assets/set-duo.webp',party:'./assets/set-party.webp',newyear:'./assets/set-party.webp'};return s.image||((s.photos||[]).find(Boolean))||fixed[s.id]||'./assets/set-party.webp';}
function setGallery(s){const own=[s.image,...(Array.isArray(s.photos)?s.photos:[])].filter(Boolean);const base=own[0]||setImage(s);const components=(s.items||[]).map(item=>{const p=find(item.id);return p?photo(p):'';}).filter(Boolean);return Array.from(new Set([base,...own.slice(1),...components])).slice(0,5);}
function setCards(){return state.sets.filter(s=>s.active!==false).map(s=>({id:'set:'+s.id,set:s,name:SET_NAMES[s.id]||s.name||'Готовый сет',price:setPrice(s),pieces:setPieces(s),weight:setWeight(s)+' г',cat:'sets',badge:s.id==='newyear'?'НОВИНКА':'',photo:setImage(s),desc:s.description||'Готовый набор роллов.'}));}
function allRows(){const sets=setCards();let a=state.filter==='sets'?sets:state.filter==='rolls'?state.products.filter(p=>['classic','warm','rolls'].includes(p.cat)):state.filter==='dogs'?state.products.filter(p=>p.cat==='dogs'):state.filter==='snacks'?state.products.filter(p=>p.cat==='snacks'):[sets.find(s=>s.set.id==='newyear'),...state.products].filter(Boolean);if(state.search)a=a.filter(p=>(p.name+' '+(p.desc||'')).toLowerCase().includes(state.search));if(state.sort==='price-asc')a.sort((x,y)=>x.price-y.price);if(state.sort==='price-desc')a.sort((x,y)=>y.price-x.price);if(state.sort==='name')a.sort((x,y)=>x.name.localeCompare(y.name,'ru'));return a;}
function card(p){const id=esc(p.id),isSet=!!p.set,limit=isSet?p.set.stock:stock(p),available=limit==null||Number(limit)>0,fav=state.favorites.has(p.id);return '<article class="product-card '+(state.selected?.id===p.id?'is-selected ':'')+(!available?'is-unavailable':'')+'" data-card="'+id+'"><div class="card-photo"><img src="'+photo(p)+'" alt="'+esc(p.name)+'" loading="lazy">'+(p.badge?'<span class="card-ribbon">'+esc(p.badge)+'</span>':'')+'<button class="card-heart '+(fav?'active':'')+'" type="button" data-fav="'+id+'" aria-label="Избранное">'+(fav?'♥':'♡')+'</button></div><div class="card-info"><h3 class="card-title">'+esc(p.name)+'</h3><div class="card-meta"><span>'+Number(p.pieces||8)+' шт.</span><span>'+esc(p.weight||'280 г')+'</span></div><div class="card-bottom"><strong class="card-price">'+money(p.price)+'</strong><button class="card-add" type="button" data-add="'+id+'" '+(!available?'disabled':'')+' aria-label="Добавить">🛒</button></div></div></article>';}
function renderCatalog(){const rows=allRows();$('#catalogueGrid').innerHTML=rows.length?rows.map(card).join(''):'<div class="loading-state">В этой категории пока нет блюд.</div>';$('#emptyState').hidden=rows.length>0;}
function renderBadges(){$('#cartCount').textContent=cartCount();$('#navCartCount').textContent=cartCount();$('#favCount').textContent=state.favorites.size;['homeCartCount','builderCartCount','basketCartCount'].forEach(id=>{if($('#'+id))$('#'+id).textContent=cartCount();});['homeFavCount','builderFavCount','basketFavCount'].forEach(id=>{if($('#'+id))$('#'+id).textContent=state.favorites.size;});}
function cartItems(){return state.products.filter(p=>qty(p.id)>0);}
function cartPieces(){return cartItems().reduce((sum,p)=>sum+(Number(p.pieces)||8)*qty(p.id),0);}
function cartWeight(){return cartItems().reduce((sum,p)=>sum+(parseInt(p.weight,10)||0)*qty(p.id),0);}
function cartSetLabel(){return Object.entries(state.setCounts).filter(([,n])=>n>0).map(([id,n])=>(SET_NAMES[id]||'Готовый сет')+' × '+n);}
function cartLine(p,compact=false){
 const id=esc(p.id),n=qty(p.id);
 return '<article class="'+(compact?'cart-line':'basket-item')+'"><img src="'+photo(p)+'" alt="'+esc(p.name)+'"><div class="basket-item-copy"><b>'+esc(p.name)+'</b><small>'+(Number(p.pieces)||8)+' шт. · '+esc(p.weight||'280 г')+' · '+money(p.price)+'</small>'+(compact?'':'<div class="basket-item-controls"><button type="button" data-cart-qty="-1" data-id="'+id+'" aria-label="Уменьшить">−</button><span>'+n+'</span><button type="button" data-cart-qty="1" data-id="'+id+'" aria-label="Увеличить">+</button></div>')+'</div><strong class="basket-item-price">'+money(p.price*n)+'</strong>'+(compact?'<div class="cart-qty"><button type="button" data-cart-qty="-1" data-id="'+id+'">−</button><span>'+n+'</span><button type="button" data-cart-qty="1" data-id="'+id+'">+</button></div>':'<button type="button" class="basket-remove" data-cart-remove="'+id+'" aria-label="Удалить">×</button>')+'</article>';
}
function renderCart(){
 const items=cartItems(),empty='<div class="empty-state">Корзина пока пуста. Выбери роллы или собери свой сет.</div>';
 const lines=items.length?items.map(p=>cartLine(p,true)).join(''):empty;
 $('#cartLines').innerHTML=lines;
 if($('#basketLines'))$('#basketLines').innerHTML=items.length?items.map(p=>cartLine(p,false)).join(''):empty;
 const names=cartSetLabel();
 if(names.length){
   const note='<p class="cart-set-note">Готовые сеты: '+names.map(esc).join(' · ')+'</p>';
   $('#cartLines').insertAdjacentHTML('beforeend',note);
   if($('#basketSetNotes'))$('#basketSetNotes').innerHTML=note;
 }else if($('#basketSetNotes'))$('#basketSetNotes').innerHTML='';
 $('#cartTotal').textContent=money(productTotal());
 $('#submitOrder').disabled=!items.length;
 if($('#basketPieces'))$('#basketPieces').textContent=cartPieces()+' шт.';
 if($('#basketWeight'))$('#basketWeight').textContent=cartWeight()+' г';
 if($('#basketTotal'))$('#basketTotal').textContent=money(productTotal());
 if($('#cartCheckout'))$('#cartCheckout').disabled=!items.length;
 if($('#basketBadgeTotal'))$('#basketBadgeTotal').textContent=items.length?items.length+' поз.':'Пока пусто';
}
function renderFavorites(){const rows=Array.from(state.favorites).map(id=>{if(id.startsWith('set:')){const s=state.sets.find(x=>x.id===id.slice(4));return s?{id,name:SET_NAMES[s.id]||s.name,price:setPrice(s),photo:setImage(s)}:null;}const p=find(id);return p?{id:p.id,name:p.name,price:p.price,photo:photo(p)}:null;}).filter(Boolean);$('#favoritesList').innerHTML=rows.length?rows.map(x=>'<div class="favorite-row"><img src="'+x.photo+'" alt=""><span>'+esc(x.name)+'<br><small>'+money(x.price)+'</small></span><button type="button" data-remove-fav="'+esc(x.id)+'">Убрать</button></div>').join(''):'<div class="empty-state">Пока ничего не сохранено.</div>';}
function renderAll(){renderCatalog();renderBadges();renderCart();renderFavorites();if(state.activeScreen==='builderScreen')renderBuilder();if(state.activeScreen==='basketScreen')renderCart();}
function openModal(id){const n=$('#'+id);n.classList.add('show');n.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';if(id==='cartModal'){renderCart();preparePickup();updateCheckoutFulfillment($('#fulfillment').value||'Самовывоз');}if(id==='favoritesModal')renderFavorites();if(id==='filtersModal')renderFilterOptions();}
function closeModal(id){const n=$('#'+id);if(!n)return;n.classList.remove('show');n.setAttribute('aria-hidden','true');if(!$('.modal-layer.show'))document.body.style.overflow='';}
function renderFilterOptions(){const options=[['all','Все позиции'],['sets','Сеты'],['rolls','Роллы'],['dogs','Азиатские хот-доги'],['snacks','Закуски']];$('#filterOptions').innerHTML=options.map(x=>'<button type="button" data-filter-option="'+x[0]+'" class="'+(state.filter===x[0]?'active':'')+'">'+x[1]+'</button>').join('');}
function detail(p,openOnMobile=true){
 if(!p)return;
 state.selected=p;state.detailQty=1;
 state.photos=p.set?setGallery(p.set):[photo(p),...state.products.filter(x=>x.id!==p.id).map(x=>photo(x))].filter(Boolean).slice(0,5);
 state.photos=Array.from(new Set(state.photos)).slice(0,5);state.photoIndex=0;
 $('#detailHero').src=state.photos[0]||photo(p);$('#detailHero').alt=p.name;
 $('#detailName').textContent=p.name;$('#detailDescription').textContent=p.desc||'Свежеприготовленное блюдо.';
 $('#detailPieces').textContent=(p.pieces||8)+' шт.';$('#detailWeight').textContent=p.weight||'280 г';
 $('#detailPrice').textContent=money(p.price);$('#detailQty').textContent='1';
 $('#detailExtra').textContent=p.set?'':(p.details||p.desc||'');
 $('#detailFavorite').textContent=state.favorites.has(p.id)?'♥':'♡';
 $('#detailCompositionTitle').textContent=p.set?'Состав сета':'Состав';
 $('#photoStrip').innerHTML=state.photos.map((src,i)=>'<button class="thumb '+(i===0?'active':'')+'" type="button" data-photo-index="'+i+'"><img src="'+src+'" alt="Фото '+(i+1)+'"></button>').join('')+'<button class="thumb thumb-next" type="button" data-gallery-next>›</button>';
 const counter=$('#detailPhotoCount');if(counter){counter.textContent='1 / '+Math.max(1,state.photos.length);counter.hidden=state.photos.length<2;}
 const ingredients=[['🐟','Лосось'],['🧀','Сливочный<br>сыр'],['🥒','Огурец'],['🍚','Рис'],['🌿','Нори']];
 const grid=$('#ingredientGrid');grid.classList.toggle('set-composition-grid',!!p.set);
 if(p.set){
   const rows=(p.set.items||[]).map(item=>{const component=find(item.id);if(!component)return '';const pieces=Number(component.pieces)||8;const multiplier=Number(item.qty)||1;return '<div class="set-component" title="'+esc(component.name)+'"><img src="'+photo(component)+'" alt="'+esc(component.name)+'" loading="lazy"><b>'+esc(component.name)+'</b><small>'+pieces+' шт.'+(multiplier>1?' × '+multiplier:'')+'</small></div>';}).filter(Boolean);
   grid.innerHTML=rows.length?rows.join(''):'<div class="set-component-empty">Состав пока не заполнен.</div>';
 }else{
   grid.innerHTML=ingredients.map(x=>'<div><strong class="ingredient-emoji">'+x[0]+'</strong><span>'+x[1]+'</span></div>').join('');
 }
 const limit=p.set?(p.set.stock==null?null:Math.max(0,Number(p.set.stock)||0)):stock(p);
 $('#detailAdd').disabled=limit===0;
 if(openOnMobile&&matchMedia('(max-width:1120px)').matches){$('#detailDevice').classList.add('mobile-active');document.body.classList.add('detail-open');}
 renderCatalog();
}
function setDetail(s){detail({id:'set:'+s.id,name:SET_NAMES[s.id]||s.name||'Готовый сет',price:setPrice(s),pieces:setPieces(s),weight:setWeight(s)+' г',set:s,desc:s.description||'Готовый набор роллов.'});}
function addProduct(p,n){if(!p)return;const next=qty(p.id)+(n||1),limit=stock(p);if(limit!==null&&next>limit){toast(limit===0?'Нет в наличии':'Осталось '+Math.max(0,limit-qty(p.id))+' шт.');return;}state.cart[p.id]=next;state.setCounts={};save();renderAll();toast('Добавлено в корзину');}
function addSet(s,n){if(!s)return;const amount=n||1,old=Number(state.setCounts[s.id]||0);if(s.stock!=null&&old+amount>Number(s.stock)){toast('Сет закончился.');return;}for(const item of s.items||[]){const p=find(item.id),limit=stock(p);if(!p||(limit!==null&&qty(p.id)+Number(item.qty)*amount>limit)){toast('Недостаточно ингредиентов для этого сета.');return;}}for(const item of s.items||[])state.cart[item.id]=qty(item.id)+Number(item.qty)*amount;state.setCounts[s.id]=old+amount;save();renderAll();toast('Сет добавлен в корзину');}
function addSelected(){if(!state.selected)return;if(state.selected.set)addSet(state.selected.set,state.detailQty);else addProduct(state.selected,state.detailQty);}
function changeDetail(d){const p=state.selected;let max=99;if(p){if(p.set&&p.set.stock!=null)max=Math.max(0,Number(p.set.stock)||0);else if(!p.set&&stock(p)!==null)max=stock(p);}if(max===0){state.detailQty=0;}else{state.detailQty=Math.min(max,Math.max(1,state.detailQty+d));}$('#detailQty').textContent=state.detailQty;$('#detailAdd').disabled=max===0||state.detailQty===0;}
function changeCart(id,d){const p=find(id),n=qty(id)+d;if(!p)return;if(n<=0)delete state.cart[id];else if(stock(p)!==null&&n>stock(p)){toast('Больше нет в наличии.');return;}else state.cart[id]=n;state.setCounts={};save();renderAll();}
const DAYS=['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
function dateString(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function hoursFor(d){return (state.settings.weekly_hours||[]).find(x=>x.day===DAYS[d.getDay()])||{open:'12:00',close:'21:00',closed:[0,3].includes(d.getDay())};}
function initialDate(){const now=new Date();for(let i=0;i<14;i++){const d=new Date(now);d.setDate(now.getDate()+i);const h=hoursFor(d);if(!h.closed&&h.open&&h.close)return d;}return now;}
async function refreshTimes(){const value=$('#pickupDate').value,select=$('#pickupTime');if(!value)return;const parts=value.split('-').map(Number),h=hoursFor(new Date(parts[0],parts[1]-1,parts[2]));if(h.closed){select.innerHTML='<option value="">Выходной</option>';return;}let busy=[];try{busy=(await apiGet('/api/availability?date='+encodeURIComponent(value))).unavailable_times||[];}catch(e){}const minutes=s=>{const a=s.split(':').map(Number);return a[0]*60+a[1];};const now=new Date(),opts=[];for(let t=minutes(h.open);t<minutes(h.close);t+=30){if(value===dateString(now)&&t<=now.getHours()*60+now.getMinutes()+30)continue;const v=String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');opts.push('<option value="'+v+'" '+(busy.includes(v)?'disabled':'')+'>'+v+(busy.includes(v)?' — занято':'')+'</option>');}select.innerHTML='<option value="">Выбрать время</option>'+opts.join('');}
function preparePickup(){const date=$('#pickupDate');if(!date.value){date.min=dateString(new Date());date.value=dateString(initialDate());}refreshTimes();}
function pickupLabel(date,time){const p=date.split('-').map(Number),d=new Date(p[0],p[1]-1,p[2]);const label=date===dateString(new Date())?'Сегодня':date===dateString(new Date(Date.now()+86400000))?'Завтра':DAYS[d.getDay()];return label+' ('+date+') в '+time;}
function builderEffective(){
 const out={...state.builderItems};
 for(const [setId,count] of Object.entries(state.builderSets)){
  const s=state.sets.find(x=>x.id===setId);if(!s)continue;
  for(const row of s.items||[])out[row.id]=(Number(out[row.id])||0)+(Number(row.qty)||0)*Number(count||0);
 }
 return out;
}
function builderMetrics(){
 const items=builderEffective(),rows=Object.entries(items).filter(([,n])=>Number(n)>0);
 return rows.reduce((a,[id,n])=>{const p=find(id);if(!p)return a;a.positions++;a.pieces+=(Number(p.pieces)||8)*Number(n);a.weight+=(parseInt(p.weight,10)||0)*Number(n);a.total+=Number(p.price||0)*Number(n);return a;},{positions:0,pieces:0,weight:0,total:0});
}
function builderProductCard(p){
 const n=Number(state.builderItems[p.id]||0),id=esc(p.id);
 return '<article class="builder-card '+(n?'selected':'')+'"><div class="builder-card-photo"><img src="'+photo(p)+'" alt="'+esc(p.name)+'" loading="lazy">'+(n?'<span class="builder-check">✓</span>':'')+'</div><div class="builder-card-copy"><b>'+esc(p.name)+'</b><small>'+(Number(p.pieces)||8)+' шт. · '+esc(p.weight||'280 г')+'</small><strong>'+money(p.price)+'</strong></div>'+(n?'<div class="builder-card-stepper"><button type="button" data-builder-product="'+id+'" data-delta="-1">−</button><span>'+n+'</span><button type="button" data-builder-product="'+id+'" data-delta="1">+</button></div>':'<button type="button" class="builder-add-one" data-builder-product="'+id+'" data-delta="1" aria-label="Добавить">+</button>')+'</article>';
}
function builderSetCard(s){
 const n=Number(state.builderSets[s.id]||0);
 const image=setImage(s),id=esc(s.id);
 const title=SET_NAMES[s.id]||s.name||'Готовый сет';
 return '<article class="builder-card '+(n?'selected':'')+'"><div class="builder-card-photo"><img src="'+image+'" alt="'+esc(title)+'" loading="lazy">'+(n?'<span class="builder-check">✓</span>':'')+'</div><div class="builder-card-copy"><b>'+esc(title)+'</b><small>'+setPieces(s)+' шт. · '+setWeight(s)+' г</small><strong>'+money(setPrice(s))+'</strong></div>'+(n?'<div class="builder-card-stepper"><button type="button" data-builder-set="'+id+'" data-delta="-1">−</button><span>'+n+'</span><button type="button" data-builder-set="'+id+'" data-delta="1">+</button></div>':'<button type="button" class="builder-add-one" data-builder-set="'+id+'" data-delta="1" aria-label="Добавить сет">+</button>')+'</article>';
}
function renderBuilder(){
 const filter=state.builderFilter;
 let list=[];
 if(filter==='sets')list=state.sets.filter(s=>s.active!==false).map(builderSetCard);
 else{
  const products=state.products.filter(p=>{
   const c=String(p.cat||p.category||'').toLowerCase();
   if(filter==='all')return true;
   if(filter==='rolls')return ['classic','warm','rolls','roll'].includes(c);
   if(filter==='dogs')return c.includes('dog')||c.includes('hot')||c.includes('хот');
   if(filter==='snacks')return c.includes('snack')||c.includes('закус');
   return false;
  });
  list=products.map(builderProductCard);
 }
 $('#builderGrid').innerHTML=list.length?list.join(''):'<div class="builder-empty"><span>🍣</span><b>Пока нет доступных блюд</b><small>В этой категории ещё нет активных позиций в меню.</small></div>';
 $$('.builder-filter').forEach(b=>b.classList.toggle('active',b.dataset.builderFilter===filter));
 const m=builderMetrics();
 $('#builderPositions').textContent=m.positions+' поз.';
 $('#builderPieces').textContent=m.pieces+' шт.';
 $('#builderWeight').textContent=m.weight+' г';
 $('#builderTotal').textContent=money(m.total);
 $('#builderAddToCart').disabled=m.positions===0||m.total<=0;
}
function changeBuilderProduct(id,delta){
 const p=find(id);if(!p)return;
 const next=Math.max(0,Number(state.builderItems[id]||0)+delta),previous=state.builderItems[id];
 if(next)state.builderItems[id]=next;else delete state.builderItems[id];
 const effective=builderEffective(),invalid=Object.entries(effective).some(([productId,n])=>{const row=find(productId),limit=stock(row);return !row||(limit!==null&&qty(productId)+Number(n)>limit);});
 if(invalid){if(previous)state.builderItems[id]=previous;else delete state.builderItems[id];toast('Недостаточно остатков для выбранного количества.');return;}
 renderBuilder();
}
function changeBuilderSet(id,delta){
 const s=state.sets.find(x=>x.id===id);if(!s)return;
 const next=Math.max(0,Number(state.builderSets[id]||0)+delta);
 if(s.stock!=null&&next>Number(s.stock)){toast('Доступное количество сета: '+s.stock);return;}
 const proposed={...state.builderSets,[id]:next};
 const old=state.builderSets;state.builderSets=proposed;
 const effective=builderEffective();
 const invalid=Object.entries(effective).some(([pid,n])=>{const p=find(pid),limit=stock(p);return !p||(limit!==null&&qty(pid)+Number(n)>limit);});
 if(invalid){state.builderSets=old;toast('Недостаточно остатков для выбранного количества.');return;}
 if(next)state.builderSets[id]=next;else delete state.builderSets[id];
 renderBuilder();
}
function addBuilderToCart(){
 const items=builderEffective(),rows=Object.entries(items).filter(([,n])=>Number(n)>0);
 if(!rows.length){toast('Сначала выбери блюда для своего сета.');return;}
 for(const [id,n] of rows){const p=find(id),limit=stock(p);if(!p||(limit!==null&&qty(id)+Number(n)>limit)){toast('Недостаточно остатков для '+(p?.name||id)+'.');return;}}
 for(const [id,n] of rows)state.cart[id]=qty(id)+Number(n);
 for(const [id,n] of Object.entries(state.builderSets))if(n>0)state.setCounts[id]=(Number(state.setCounts[id])||0)+Number(n);
 state.builderItems={};state.builderSets={};save();renderAll();showCartScreen();toast('Твой сет добавлен в корзину');
}
function activateWorkflow(screen){
 state.activeScreen=screen;
 $('.reference-board').classList.add('workflow-mode');
 $('.catalogue-device').classList.add('workflow-mode');
 $('.workflow-screen').forEach(x=>x.classList.toggle('active',x.id===screen));
 const activeNav=screen==='confirmationScreen'?'cart':screen.replace('Screen','').replace('basket','cart');
 $('.bottom-nav button').forEach(x=>x.classList.toggle('active',x.dataset.nav===activeNav));
 $('#detailDevice').classList.remove('mobile-active');
 document.body.classList.remove('detail-open');
 document.body.style.overflow='';
}
function returnToCatalogue(){
 state.activeScreen='catalogue';
 $('.reference-board').classList.remove('workflow-mode');
 $('.catalogue-device').classList.remove('workflow-mode');
 $$('.workflow-screen').forEach(x=>x.classList.remove('active'));
 $$('.bottom-nav button').forEach(x=>x.classList.toggle('active',x.dataset.nav==='catalogue'));
 document.body.style.overflow='';
}
function showHomeScreen(){activateWorkflow('homeScreen');}
function showBuilderScreen(){renderBuilder();activateWorkflow('builderScreen');}
function showCartScreen(){renderCart();activateWorkflow('basketScreen');}
function renderConfirmation(){
 const data=state.lastOrder;if(!data)return;
 $('#confirmedOrderCode').textContent=data.order_id||'Принят';
 $('#confirmedTotal').textContent=money(data.total);
 $('#confirmedWhen').textContent=data.time||'Время получения подтвердим отдельно';
 const lines=(data.items||[]).map(row=>{const p=find(row.id);return p?'<div class="confirmation-line"><img src="'+photo(p)+'" alt=""><span>'+esc(p.name)+' × '+row.qty+'</span><b>'+money(Number(p.price||0)*Number(row.qty||0))+'</b></div>':'';}).join('');const setNotes=(data.sets||[]).map(row=>(SET_NAMES[row.id]||'Готовый сет')+' × '+row.qty);$('#confirmedLines').innerHTML=lines+(setNotes.length?'<p class="cart-set-note">'+setNotes.map(esc).join(' · ')+'</p>':'');
}
function showConfirmation(data){state.lastOrder=data;renderConfirmation();activateWorkflow('confirmationScreen');}

function checkoutMapUrl(query){return 'https://yandex.ru/map-widget/v1/?text='+encodeURIComponent(query||'Чарышское, Алтайский край');}
function updateDeliveryMap(){
 const input=$('#deliveryAddress'),query=String(input?.value||'').trim()||'Чарышское, Алтайский край';
 const frame=$('#deliveryMap'),link=$('#deliveryMapLink');
 if(frame)frame.src=checkoutMapUrl(query);
 if(link)link.href='https://yandex.ru/maps/?text='+encodeURIComponent(query);
}
function updateCheckoutFulfillment(mode){
 const delivery=mode==='Доставка',value=delivery?'Доставка':'Самовывоз';
 const hidden=$('#fulfillment');if(hidden)hidden.value=value;
 $('[data-fulfillment]').forEach(button=>{
  const active=button.dataset.fulfillment===value;
  button.classList.toggle('active',active);
  button.setAttribute('aria-pressed',active?'true':'false');
 });
 const addressField=$('#deliveryAddressField'),addressInput=$('#deliveryAddress');
 if(addressField)addressField.hidden=!delivery;
 if(addressInput)addressInput.required=delivery;
 const pickup=$('#pickupLocationField'),deliveryLocation=$('#deliveryLocationField');
 if(pickup)pickup.hidden=delivery;
 if(deliveryLocation)deliveryLocation.hidden=!delivery;
 const pickupAddress=state.settings.pickup_address||'Социалистическая, 26, Чарышское';
 const pickupMap=$('#pickupMap'),pickupText=$('#pickupAddressText'),pickupLink=$('#pickupMapLink');
 if(pickupText)pickupText.textContent=pickupAddress;
 if(pickupMap)pickupMap.src=checkoutMapUrl(pickupAddress);
 if(pickupLink)pickupLink.href=state.settings.pickup_map_url||('https://yandex.ru/maps/?text='+encodeURIComponent(pickupAddress));
 $('#checkoutNote').textContent=delivery?(state.settings.delivery_note||'Стоимость и возможность доставки подтвердим после получения заказа.'):'Время самовывоза подтвердим отдельно.';
 if(delivery)updateDeliveryMap();
}
async function sendOrder(e){e.preventDefault();const form=$('#checkoutForm'),data=new FormData(form),error=$('#checkoutError');error.textContent='';if(!cartCount()){error.textContent='Корзина пуста.';return;}const telegram=tg();if(!telegram?.initData){error.textContent='Открой магазин через Telegram, чтобы отправить заказ.';return;}const name=String(data.get('name')||'').trim(),phone=String(data.get('phone')||'').trim(),date=String(data.get('pickup_date')||''),time=String(data.get('pickup_time')||''),fulfillment=String(data.get('fulfillment')||'Самовывоз'),address=String(data.get('delivery_address')||'').trim();if(!name||phone.replace(/\D/g,'').length<10||!date||!time){error.textContent='Проверь имя, телефон, дату и время.';return;}if(fulfillment==='Доставка'&&(!state.settings.delivery_enabled||!address)){error.textContent='Укажи адрес доставки.';return;}if(fulfillment==='Самовывоз'&&state.settings.pickup_enabled===false){error.textContent='Самовывоз сейчас недоступен.';return;}if(fulfillment==='Доставка'&&productTotal()<Number(state.settings.minimum_order||0)){error.textContent='Минимальная сумма доставки — '+money(state.settings.minimum_order)+'.';return;}const notes=[String(data.get('notes')||'').trim(),'Способ получения: '+fulfillment,fulfillment==='Доставка'?'Адрес доставки: '+address:''].filter(Boolean).join('\n');const payload={init_data:telegram.initData,client_order_id:form.dataset.orderId||crypto.randomUUID(),name:name,phone:phone,time:pickupLabel(date,time),notes:notes,items:state.products.filter(p=>qty(p.id)>0).map(p=>({id:p.id,qty:qty(p.id)})),sets:Object.entries(state.setCounts).filter(([,n])=>n>0).map(([id,n])=>({id:id,qty:Number(n)}))};form.dataset.orderId=payload.client_order_id;const button=$('#submitOrder');button.disabled=true;button.textContent='Отправляем…';try{telegram.ready();telegram.expand();const r=await fetch(API+'/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'}),result=await r.json().catch(()=>({}));if(!r.ok||result.ok!==true)throw Error(typeof result.detail==='string'?result.detail:'Сервер не подтвердил заказ.');const submitted={order_id:result.order_id,total:Number(result.total)||productTotal(),time:payload.time,items:payload.items,sets:payload.sets};state.cart={};state.setCounts={};save();renderAll();closeModal('cartModal');form.reset();delete form.dataset.orderId;showConfirmation(submitted);}catch(err){error.textContent=err.message||'Не удалось отправить заказ.';}finally{button.disabled=!cartCount();button.textContent='Отправить заказ ↗';}}
async function load(){let fallback={products:[]};try{fallback=await (await fetch('./assets/local-catalog-fallback.json',{cache:'force-cache'})).json();}catch(e){}const results=await Promise.allSettled([apiGet('/api/menu'),apiGet('/api/site-content'),apiGet('/api/store-settings')]);const local=new Map((fallback.products||[]).map(p=>[p.id,p]));state.products=results[0].status==='fulfilled'?results[0].value.filter(p=>p.active!==false).map(p=>({...local.get(p.id),...p,photo:p.photo||local.get(p.id)?.photo||''})):fallback.products||[];state.sets=results[1].status==='fulfilled'?(results[1].value.sets||[]).filter(s=>s.active!==false):[];state.settings=results[2].status==='fulfilled'?results[2].value:{};loadSaved();for(const id of Object.keys(state.cart)){const p=find(id);if(!p){delete state.cart[id];continue;}if(stock(p)!==null)state.cart[id]=Math.min(stock(p),qty(id));}renderAll();const first=find('philadelphia')||state.products[0];if(first)detail(first,false);const app=tg();if(app){app.ready();app.expand();}const settings=state.settings,phone=settings.phone||'+7 923 000-58-57',digits=phone.replace(/\D/g,'');$('#headerPhone')?.setAttribute('href','tel:+7'+digits.slice(-10));$('#footerPhone')?.setAttribute('href','tel:+7'+digits.slice(-10));}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.filter){state.filter=b.dataset.filter;$$('.category-tile').forEach(x=>x.classList.toggle('active',x===b));renderCatalog();return;}if(b.dataset.add){const id=b.dataset.add;if(id.startsWith('set:'))addSet(state.sets.find(s=>s.id===id.slice(4)));else addProduct(find(id),1);return;}if(b.dataset.fav){const id=b.dataset.fav;state.favorites.has(id)?state.favorites.delete(id):state.favorites.add(id);save();renderAll();return;}if(b.dataset.cartQty){changeCart(b.dataset.id,Number(b.dataset.cartQty));return;}if(b.dataset.cartRemove){changeCart(b.dataset.cartRemove,-qty(b.dataset.cartRemove));return;}if(b.dataset.builderFilter!==undefined){state.builderFilter=b.dataset.builderFilter;renderBuilder();return;}if(b.dataset.builderProduct){changeBuilderProduct(b.dataset.builderProduct,Number(b.dataset.delta)||0);return;}if(b.dataset.builderSet){changeBuilderSet(b.dataset.builderSet,Number(b.dataset.delta)||0);return;}if(b.hasAttribute('data-workflow-back')){returnToCatalogue();return;}if(b.id==='builderAddToCart'){addBuilderToCart();return;}if(b.id==='cartCheckout'){openModal('cartModal');return;}if(b.id==='cartKeepShopping'){returnToCatalogue();return;}if(b.id==='confirmationHome'){showHomeScreen();return;}if(b.hasAttribute('data-open-cart')){showCartScreen();return;}if(b.hasAttribute('data-open-favorites')){openModal('favoritesModal');return;}if(b.dataset.close){closeModal(b.dataset.close);return;}if(b.dataset.photoIndex!==undefined){state.photoIndex=Number(b.dataset.photoIndex);$('#detailHero').src=state.photos[state.photoIndex];$$('.thumb').forEach((x,i)=>x.classList.toggle('active',i===state.photoIndex));const counter=$('#detailPhotoCount');if(counter)counter.textContent=(state.photoIndex+1)+' / '+state.photos.length;return;}if(b.hasAttribute('data-gallery-next')){state.photoIndex=(state.photoIndex+1)%state.photos.length;$('#detailHero').src=state.photos[state.photoIndex];$$('.thumb').forEach((x,i)=>x.classList.toggle('active',i===state.photoIndex));const counter=$('#detailPhotoCount');if(counter)counter.textContent=(state.photoIndex+1)+' / '+state.photos.length;return;}if(b.id==='detailBack'){document.body.classList.remove('detail-open');$('#detailDevice').classList.remove('mobile-active');return;}if(b.id==='detailMinus'){changeDetail(-1);return;}if(b.id==='detailPlus'){changeDetail(1);return;}if(b.id==='detailAdd'){addSelected();return;}if(b.id==='detailFavorite'&&state.selected){const id=state.selected.id;state.favorites.has(id)?state.favorites.delete(id):state.favorites.add(id);save();renderBadges();b.textContent=state.favorites.has(id)?'♥':'♡';return;}if(b.id==='detailShare'){if(navigator.share)navigator.share({title:state.selected?.name||'Тихий ролл',url:location.href}).catch(()=>{});else toast('Поделись ссылкой на магазин.');return;}if(b.id==='filterOpen'||b.classList.contains('menu-trigger')){openModal('filtersModal');return;}if(b.dataset.filterOption){state.filter=b.dataset.filterOption;renderFilterOptions();return;}if(b.id==='applyFilters'){renderCatalog();closeModal('filtersModal');return;}if(b.dataset.removeFav){state.favorites.delete(b.dataset.removeFav);save();renderFavorites();renderBadges();return;}if(b.dataset.fulfillment){updateCheckoutFulfillment(b.dataset.fulfillment);return;}if(b.hasAttribute('data-home-catalog')){returnToCatalogue();return;}if(b.hasAttribute('data-home-builder')){showBuilderScreen();return;}if(b.dataset.homeFilter){state.filter=b.dataset.homeFilter;returnToCatalogue();$('.category-tile').forEach(x=>x.classList.toggle('active',x.dataset.filter===state.filter));renderCatalog();return;}if(b.dataset.nav==='home'){showHomeScreen();return;}if(b.dataset.nav==='catalogue'){returnToCatalogue();return;}if(b.dataset.nav==='builder'){showBuilderScreen();return;}if(b.dataset.nav==='cart'){showCartScreen();return;}});
$('#catalogueGrid').addEventListener('click',e=>{if(e.target.closest('button'))return;const el=e.target.closest('[data-card]');if(!el)return;const id=el.dataset.card;if(id.startsWith('set:')){const s=state.sets.find(x=>x.id===id.slice(4));if(s)setDetail(s);}else detail(find(id));});
$('#sortSelect').addEventListener('change',e=>{state.sort=e.target.value;renderCatalog();});
$('#catalogSearch').addEventListener('input',e=>{state.search=e.target.value.trim().toLowerCase();renderCatalog();});
$('#pickupDate').addEventListener('change',refreshTimes);
$('#checkoutForm').addEventListener('submit',sendOrder);
$('#deliveryAddress').addEventListener('change',updateDeliveryMap);
$$('.modal-layer').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModal(m.id);}));
window.addEventListener('keydown',e=>{if(e.key==='Escape'){['cartModal','favoritesModal','filtersModal'].forEach(closeModal);$('#detailDevice').classList.remove('mobile-active');}});
load().catch(e=>{console.error(e);toast('Не удалось загрузить меню.');});
})();