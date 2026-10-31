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
function productCategory(p){
 const raw=String(p.cat||p.category_id||p.category||'').toLowerCase().trim();
 const c=raw.replace(/[ _]+/g,'-');
 if(['dogs','dog','hotdog','hot-dog','hotdogs','hot-dogs','asian-hot-dogs','asian-hotdog','азиатские-хот-доги','азиатский-хот-дог'].includes(c)||c.includes('dog')||c.includes('хот-дог'))return 'dogs';
 if(['snacks','snack','закуски','закуска'].includes(c)||c.includes('snack')||c.includes('закус'))return 'snacks';
 if(['classic','warm','rolls','roll','classic-rolls'].includes(c)||c.includes('roll')||c.includes('ролл')||c==='warm')return 'rolls';
 return c;
}
function productKind(p){
 if(p?.set)return 'Сет';
 const category=productCategory(p||{});
 if(category==='dogs')return 'Азиатский хот-дог';
 if(category==='snacks')return 'Закуска';
 return 'Ролл';
}
function compositionValue(value){
 if(Array.isArray(value))return value.map(item=>{
  if(typeof item==='string')return item;
  if(item&&typeof item==='object')return item.name||item.title||item.ingredient||item.label||'';
  return '';
 }).filter(Boolean).join(', ');
 if(value&&typeof value==='object')return value.name||value.title||value.ingredient||value.label||'';
 return String(value||'').trim();
}
function productDescription(p){
 const details=compositionValue(p?.details)||compositionValue(p?.composition)||compositionValue(p?.ingredients);
 const desc=compositionValue(p?.desc)||compositionValue(p?.description);
 if(desc&&/временная карточка-образец/i.test(desc)&&details)return details;
 if(desc)return desc;
 if(details)return details;
 const defaults={
  philadelphia:'Нежный лосось, сливочный сыр, свежий огурец и рис.',
  lava:'Нежный соус лава, сливочный сыр и свежие ингредиенты.',
  warm_crab:'Тёплый ролл с крабом и аппетитной золотистой корочкой.',
  warm_salmon:'Тёплый ролл с лососем, приготовленный до золотистой корочки.',
  california:'Классический ролл с нежной начинкой и рисом.',
  unagi:'Ролл с угрём и насыщенным соусом унаги.',
  asian_hotdog_shrimp:'Креветка, рис, соус и хрустящая булочка.',
  asian_hotdog_chicken:'Курица, сливочный соус, рис и хрустящая булочка.',
  snack_tempura_shrimp:'Креветки в хрустящей темпуре с соусом.',
  snack_crispy_rolls:'Хрустящая закуска с крабом, сливочным сыром и рисом.'
 };
 return defaults[p?.id]||'Свежеприготовленное блюдо из меню «Тихий ролл».';
}
function ingredientRows(p){
 const source=[p?.details,p?.composition,p?.ingredients,p?.desc,p?.description].map(compositionValue).filter(Boolean).join(', ')+' '+productDescription(p);
 const patterns=[
  [/лосос|salmon/i,'🐟','Лосось'],[/кревет|shrimp/i,'🦐','Креветка'],[/краб|crab/i,'🦀','Краб'],
  [/икр|caviar/i,'🟠','Икра'],[/сыр|cheese/i,'🧀','Сливочный сыр'],[/огурц|cucumber/i,'🥒','Огурец'],
  [/авокад|avocado/i,'🥑','Авокадо'],[/рис|rice/i,'🍚','Рис'],[/нори|водорос|seaweed/i,'🌿','Нори'],
  [/угор|unagi|eel/i,'🐟','Угорь'],[/куриц|chicken/i,'🍗','Курица'],[/соус|sauce/i,'🥣','Соус'],
  [/темпур|паниров|хруст|crispy/i,'🍤','Темпура'],[/кунжут|sesame/i,'🌰','Кунжут'],[/лук|onion/i,'🧅','Лук'],
  [/мяс|beef|говядин/i,'🥩','Мясо']
 ];
 const rows=patterns.filter(([pattern])=>pattern.test(source)).map(([,icon,label])=>({icon,label}));
 const seen=new Set();return rows.filter(row=>{if(seen.has(row.label))return false;seen.add(row.label);return true;}).slice(0,8);
}
function ingredientMarkup(p){
 const rows=ingredientRows(p);
 if(!rows.length)return '<div class="ingredient-chip"><strong>🍽️</strong><span>Состав уточняется</span></div>';
 return rows.map(row=>'<div class="ingredient-chip"><strong>'+row.icon+'</strong><span>'+esc(row.label)+'</span></div>').join('');
}
function showBuilderInfo(id){
 const key=String(id||'');let item;
 if(key.startsWith('set:')){
  const s=state.sets.find(row=>row.id===key.slice(4));if(!s)return;
  item={id:key,name:SET_NAMES[s.id]||s.name||'Готовый сет',price:setPrice(s),pieces:setPieces(s),weight:setWeight(s)+' г',desc:s.description||'Готовый набор роллов.',set:s};
 }else item=find(key);
 if(!item)return;
 $('#builderInfoName').textContent=item.name;
 $('#builderInfoDescription').textContent=productDescription(item);
 $('#builderInfoPieces').textContent=(Number(item.pieces)||8)+' шт.';
 $('#builderInfoWeight').textContent=item.weight||'280 г';
 $('#builderInfoPrice').textContent=money(item.price);
 $('#builderInfoIngredients').innerHTML=item.set
  ?(item.set.items||[]).map(row=>{const p=find(row.id);return p?'<div class="ingredient-chip"><strong>🍣</strong><span>'+esc(p.name)+(Number(row.qty)>1?' × '+row.qty:'')+'</span></div>':'';}).join('')||'<div class="ingredient-chip"><strong>🍽️</strong><span>Состав уточняется</span></div>'
  :ingredientMarkup(item);
 openModal('builderInfoModal');
}
function allRows(){
 const sets=setCards();
 let a=state.filter==='sets'?sets:
  state.filter==='rolls'?state.products.filter(p=>productCategory(p)==='rolls'):
  state.filter==='dogs'?state.products.filter(p=>productCategory(p)==='dogs'):
  state.filter==='snacks'?state.products.filter(p=>productCategory(p)==='snacks'):
  [...sets,...state.products];
 if(state.search)a=a.filter(p=>(p.name+' '+(p.desc||'')).toLowerCase().includes(state.search));
 if(state.sort==='price-asc')a.sort((x,y)=>x.price-y.price);
 if(state.sort==='price-desc')a.sort((x,y)=>y.price-x.price);
 if(state.sort==='name')a.sort((x,y)=>x.name.localeCompare(y.name,'ru'));
 return a;
}
function card(p){
 const id=esc(p.id),isSet=!!p.set,limit=isSet?p.set.stock:stock(p),available=limit==null||Number(limit)>0,fav=state.favorites.has(p.id);
 const selected=isSet?Number(state.setCounts[p.set.id]||0):qty(p.id);
 const controls=selected>0
  ?'<div class="card-quantity" aria-label="Количество в корзине"><button type="button" data-card-qty="-1" data-id="'+id+'" aria-label="Уменьшить количество">−</button><span>'+selected+'</span><button type="button" data-card-qty="1" data-id="'+id+'" '+(!available?'disabled':'')+' aria-label="Увеличить количество">+</button></div>'
  :'<button class="card-add" type="button" data-card-qty="1" data-id="'+id+'" '+(!available?'disabled':'')+' aria-label="Добавить в корзину">+</button>';
 const desc=productDescription(p);
 return '<article class="product-card '+(state.selected?.id===p.id?'is-selected ':'')+(!available?'is-unavailable':'')+'" data-card="'+id+'"><div class="card-photo"><img src="'+photo(p)+'" alt="'+esc(p.name)+'" loading="lazy">'+(p.badge?'<span class="card-ribbon">'+esc(p.badge)+'</span>':'')+'<button class="card-heart '+(fav?'active':'')+'" type="button" data-fav="'+id+'" aria-label="Избранное">'+(fav?'♥':'♡')+'</button></div><div class="card-info"><h3 class="card-title">'+esc(p.name)+'</h3><p class="card-description">'+esc(desc)+'</p><div class="card-meta"><span>'+Number(p.pieces||8)+' шт.</span><span>'+esc(p.weight||'280 г')+'</span></div><button class="card-composition" type="button" data-composition="'+id+'"><span aria-hidden="true">✦</span> Состав</button><div class="card-bottom card-purchase"><strong class="card-price">'+money(p.price)+'</strong>'+controls+'</div></div></article>';
}
function renderHomeContent(){
 const hero=$('#homeHeroPhoto');
 const rolls=state.products.filter(p=>productCategory(p)==='rolls');
 const dogs=state.products.filter(p=>productCategory(p)==='dogs');
 const snacks=state.products.filter(p=>productCategory(p)==='snacks');
 const sets=state.sets.filter(s=>s.active!==false);
 const set=sets.find(s=>s.id==='newyear')||sets[0];
 const heroProduct=state.products.find(p=>p.id==='philadelphia')||rolls[0]||state.products[0];
 if(hero&&heroProduct)hero.src=photo(heroProduct);
 const fav=id=>state.products.find(p=>p.id===id);
 const roll=rolls.find(p=>p.id==='philadelphia')||rolls[0]||heroProduct;
 const images={
  sets:set?setImage(set):(heroProduct?photo(heroProduct):''),
  rolls:roll?photo(roll):'',
  dogs:dogs[0]?photo(dogs[0]):(fav('warm_salmon')?photo(fav('warm_salmon')):'./assets/set-duo.webp'),
  snacks:snacks[0]?photo(snacks[0]):(fav('unagi')?photo(fav('unagi')):'./assets/set-solo.webp')
 };
 Object.entries(images).forEach(([key,src])=>{
  const image=$('[data-home-category-image="'+key+'"]');if(image&&src)image.src=src;
 });
 const promoSet=sets.find(row=>row.id==='newyear')||sets[0];
 const promoImage=$('#homeNewYearImage'),promoTitle=$('#homeNewYearTitle'),promoText=$('#homeNewYearText'),promoPrice=$('#homeNewYearPrice');
 if(promoSet){
  if(promoImage)promoImage.src=setImage(promoSet);
  if(promoTitle)promoTitle.textContent=SET_NAMES[promoSet.id]||promoSet.name||'Новогодний сет';
  if(promoText)promoText.textContent=promoSet.description||'Праздничный набор роллов для особенного вечера.';
  if(promoPrice)promoPrice.textContent=money(setPrice(promoSet));
 }
 const popular=$('#homePopularGrid');
 if(popular){
  const preferred=['philadelphia','lava','warm_crab','warm_salmon'];
  const ordered=preferred.map(id=>fav(id)).filter(Boolean);
  const rest=rolls.filter(p=>!preferred.includes(p.id));
  popular.innerHTML=[...ordered,...rest].slice(0,4).map(card).join('');
 }
}
function renderCatalog(){
 const rows=allRows();
 $('#catalogueGrid').innerHTML=rows.length?rows.map(card).join(''):'<div class="loading-state">В этой категории пока нет блюд.</div>';
 $('#emptyState').hidden=rows.length>0;
}
function renderBadges(){
 const cart=cartCount(),favorites=state.favorites.size;
 ['cartCount','navCartCount','homeCartCount','builderCartCount','basketCartCount','favoritesScreenCartCount'].forEach(id=>{const node=$('#'+id);if(node)node.textContent=cart;});
 ['favCount','homeFavCount','builderFavCount','basketFavCount','favoritesScreenFavCount'].forEach(id=>{const node=$('#'+id);if(node)node.textContent=favorites;});
}
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
function favoriteRows(){
 const sets=new Map(setCards().map(row=>[row.id,row]));
 return Array.from(state.favorites).map(id=>id.startsWith('set:')?sets.get(id):find(id)).filter(Boolean);
}
function renderFavorites(){
 const rows=favoriteRows();
 const grid=$('#favoritesGrid'),empty=$('#favoritesEmpty');
 if(grid)grid.innerHTML=rows.length?rows.map(card).join(''):'';
 if(empty)empty.hidden=rows.length>0;
 const list=$('#favoritesList');
 if(list)list.innerHTML=rows.length?rows.map(x=>'<div class="favorite-row"><img src="'+photo(x)+'" alt=""><span>'+esc(x.name)+'<br><small>'+money(x.price)+'</small></span><button type="button" data-remove-fav="'+esc(x.id)+'">Убрать</button></div>').join(''):'<div class="empty-state">Пока ничего не сохранено.</div>';
}
function renderAll(){renderCatalog();renderHomeContent();renderBadges();renderCart();renderFavorites();if(state.activeScreen==='builderScreen')renderBuilder();if(state.activeScreen==='basketScreen')renderCart();}
function openModal(id){const n=$('#'+id);n.classList.add('show');n.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';if(id==='cartModal'){renderCart();preparePickup();updateCheckoutFulfillment($('#fulfillment').value||'Самовывоз');}if(id==='favoritesModal')renderFavorites();if(id==='filtersModal')renderFilterOptions();}
function closeModal(id){const n=$('#'+id);if(!n)return;n.classList.remove('show');n.setAttribute('aria-hidden','true');if(!$('.modal-layer.show'))document.body.style.overflow='';}
function renderFilterOptions(){const options=[['all','Все позиции'],['sets','Сеты'],['rolls','Роллы'],['dogs','Азиатские хот-доги'],['snacks','Закуски']];$('#filterOptions').innerHTML=options.map(x=>'<button type="button" data-filter-option="'+x[0]+'" class="'+(state.filter===x[0]?'active':'')+'">'+x[1]+'</button>').join('');}
function showGalleryPhoto(index){
 if(!state.photos.length)return;
 state.photoIndex=((index%state.photos.length)+state.photos.length)%state.photos.length;
 $('#detailHero').src=state.photos[state.photoIndex];
 $$('.thumb').forEach((button,i)=>button.classList.toggle('active',i===state.photoIndex));
 const counter=$('#detailPhotoCount');
 if(counter)counter.textContent=(state.photoIndex+1)+' / '+state.photos.length;
}
function detail(p,openOnMobile=true){
 if(!p)return;
 state.selected=p;state.detailQty=1;
 const ownGallery=Array.isArray(p.gallery)?p.gallery.filter(Boolean):[];const legacyGallery=state.products.filter(item=>item.id!==p.id).map(photo);state.photos=p.set?setGallery(p.set):Array.from(new Set([photo(p),...(ownGallery.length?ownGallery:legacyGallery)])).filter(Boolean).slice(0,5);
 state.photos=Array.from(new Set(state.photos)).slice(0,5);state.photoIndex=0;
 $('#detailHero').src=state.photos[0]||photo(p);$('#detailHero').alt=p.name;
 $('#detailName').textContent=p.name;$('#detailDescription').textContent=p.desc||'Свежеприготовленное блюдо.';
 $('#detailPieces').textContent=(p.pieces||8)+' шт.';$('#detailWeight').textContent=p.weight||'280 г';
 $('#detailPrice').textContent=money(p.price);$('#detailQty').textContent='1';
 const detailExtra=$('#detailExtra');if(detailExtra){detailExtra.textContent='';detailExtra.hidden=true;}
 $('#detailFavorite').textContent=state.favorites.has(p.id)?'♥':'♡';
 $('#detailCompositionTitle').textContent=p.set?'Состав сета':'Состав';
 $('#photoStrip').innerHTML=state.photos.map((src,i)=>'<button class="thumb '+(i===0?'active':'')+'" type="button" data-photo-index="'+i+'"><img src="'+src+'" alt="Фото '+(i+1)+'"></button>').join('')+'<button class="thumb thumb-next" type="button" data-gallery-next>›</button>';
 const counter=$('#detailPhotoCount');if(counter){counter.textContent='1 / '+Math.max(1,state.photos.length);counter.hidden=state.photos.length<2;}
 const grid=$('#ingredientGrid');grid.classList.toggle('set-composition-grid',!!p.set);
 if(p.set){
   const rows=(p.set.items||[]).map(item=>{const component=find(item.id);if(!component)return '';const pieces=Number(component.pieces)||8;const multiplier=Number(item.qty)||1;return '<div class="set-component" title="'+esc(component.name)+'"><img src="'+photo(component)+'" alt="'+esc(component.name)+'" loading="lazy"><b>'+esc(component.name)+'</b><small>'+pieces+' шт.'+(multiplier>1?' × '+multiplier:'')+'</small></div>';}).filter(Boolean);
   grid.innerHTML=rows.length?rows.join(''):'<div class="set-component-empty">Состав пока не заполнен.</div>';
 }else{
   grid.innerHTML=ingredientMarkup(p);
 }
 const limit=p.set?(p.set.stock==null?null:Math.max(0,Number(p.set.stock)||0)):stock(p);
 $('#detailAdd').disabled=limit===0;
 if(openOnMobile&&matchMedia('(max-width:1120px)').matches){$('#detailDevice').classList.add('mobile-active');document.body.classList.add('detail-open');}
 renderCatalog();
}
function setDetail(s){detail({id:'set:'+s.id,name:SET_NAMES[s.id]||s.name||'Готовый сет',price:setPrice(s),pieces:setPieces(s),weight:setWeight(s)+' г',set:s,desc:s.description||'Готовый набор роллов.'});}
function addProduct(p,n){if(!p)return;const next=qty(p.id)+(n||1),limit=stock(p);if(limit!==null&&next>limit){toast(limit===0?'Нет в наличии':'Осталось '+Math.max(0,limit-qty(p.id))+' шт.');return;}state.cart[p.id]=next;state.setCounts={};save();renderAll();toast(productKind(p)+' добавлен в корзину');}
function addSet(s,n){if(!s)return;const amount=n||1,old=Number(state.setCounts[s.id]||0);if(s.stock!=null&&old+amount>Number(s.stock)){toast('Сет закончился.');return;}for(const item of s.items||[]){const p=find(item.id),limit=stock(p);if(!p||(limit!==null&&qty(p.id)+Number(item.qty)*amount>limit)){toast('Недостаточно ингредиентов для этого сета.');return;}}for(const item of s.items||[])state.cart[item.id]=qty(item.id)+Number(item.qty)*amount;state.setCounts[s.id]=old+amount;save();renderAll();toast('Сет добавлен в корзину');}
function addSelected(){if(!state.selected)return;if(state.selected.set)addSet(state.selected.set,state.detailQty);else addProduct(state.selected,state.detailQty);}
function changeDetail(d){const p=state.selected;let max=99;if(p){if(p.set&&p.set.stock!=null)max=Math.max(0,Number(p.set.stock)||0);else if(!p.set&&stock(p)!==null)max=stock(p);}if(max===0){state.detailQty=0;}else{state.detailQty=Math.min(max,Math.max(1,state.detailQty+d));}$('#detailQty').textContent=state.detailQty;$('#detailAdd').disabled=max===0||state.detailQty===0;}
function changeCart(id,d){const p=find(id),previous=qty(id),n=previous+d;if(!p)return;if(n<=0)delete state.cart[id];else if(stock(p)!==null&&n>stock(p)){toast('Больше нет в наличии.');return;}else state.cart[id]=n;state.setCounts={};save();renderAll();toast(d>0?productKind(p)+' добавлен в корзину':productKind(p)+' убран из корзины');}
function changeSetCart(id,delta){
 const s=state.sets.find(row=>row.id===id);if(!s)return;
 const current=Number(state.setCounts[id]||0);
 if(delta>0){addSet(s,delta);return;}
 const remove=Math.min(current,Math.abs(delta));if(!remove)return;
 for(const item of s.items||[]){
  const productId=item.id,next=Math.max(0,qty(productId)-Number(item.qty||0)*remove);
  if(next)state.cart[productId]=next;else delete state.cart[productId];
 }
 const remaining=current-remove;if(remaining)state.setCounts[id]=remaining;else delete state.setCounts[id];
 save();renderAll();toast('Сет убран из корзины');
}
const DAYS=['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
function storeNow(){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Barnaul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
 const v=Object.fromEntries(parts.map(x=>[x.type,x.value]));
 return new Date(Number(v.year),Number(v.month)-1,Number(v.day),Number(v.hour),Number(v.minute));
}
function dateString(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function hoursFor(d){return {open:'12:00',close:'20:00',closed:[0,3].includes(d.getDay())};}
function initialDate(){const now=storeNow();for(let i=0;i<14;i++){const d=new Date(now);d.setDate(now.getDate()+i);const h=hoursFor(d);if(!h.closed)return d;}return now;}
async function refreshTimes(){
 const value=$('#pickupDate').value,select=$('#pickupTime');if(!value)return;
 const parts=value.split('-').map(Number),h=hoursFor(new Date(parts[0],parts[1]-1,parts[2]));
 if(h.closed){select.innerHTML='<option value="">Выходной</option>';return;}
 let busy=[];try{busy=(await apiGet('/api/availability?date='+encodeURIComponent(value))).unavailable_times||[];}catch(e){}
 const minutes=s=>{const a=s.split(':').map(Number);return a[0]*60+a[1];};
 const now=storeNow(),opts=[];
 for(let t=minutes(h.open);t<minutes(h.close);t+=30){
  if(value===dateString(now)&&t<=now.getHours()*60+now.getMinutes()+30)continue;
  const v=String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');
  opts.push('<option value="'+v+'" '+(busy.includes(v)?'disabled':'')+'>'+v+(busy.includes(v)?' — занято':'')+'</option>');
 }
 select.innerHTML='<option value="">Выбрать время</option>'+opts.join('');
}
function preparePickup(){const date=$('#pickupDate'),now=storeNow();if(!date.value){date.min=dateString(now);date.value=dateString(initialDate());}else date.min=dateString(now);refreshTimes();}
function pickupLabel(date,time){
 const p=date.split('-').map(Number),d=new Date(p[0],p[1]-1,p[2]),now=storeNow(),tomorrow=new Date(now);tomorrow.setDate(now.getDate()+1);
 const label=date===dateString(now)?'Сегодня':date===dateString(tomorrow)?'Завтра':DAYS[d.getDay()];
 return label+' ('+date+') в '+time;
}
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
 const controls=n
  ?'<div class="card-quantity builder-card-stepper"><button type="button" data-builder-product="'+id+'" data-delta="-1" aria-label="Уменьшить">−</button><span>'+n+'</span><button type="button" data-builder-product="'+id+'" data-delta="1" aria-label="Увеличить">+</button></div>'
  :'<button type="button" class="card-add builder-add-one" data-builder-product="'+id+'" data-delta="1" aria-label="Добавить">+</button>';
 return '<article class="builder-card '+(n?'selected':'')+'" data-builder-info="'+id+'" tabindex="0" aria-label="Состав: '+esc(p.name)+'"><div class="builder-card-photo"><img src="'+photo(p)+'" alt="'+esc(p.name)+'" loading="lazy"></div><div class="builder-card-copy"><b>'+esc(p.name)+'</b><p class="builder-card-description">'+esc(productDescription(p))+'</p><small>'+(Number(p.pieces)||8)+' шт. · '+esc(p.weight||'280 г')+'</small><button type="button" class="card-composition builder-card-composition" data-composition="'+id+'"><span aria-hidden="true">✦</span> Состав</button><div class="builder-card-footer"><strong>'+money(p.price)+'</strong>'+controls+'</div></div></article>';
}
function builderSetCard(s){
 const n=Number(state.builderSets[s.id]||0),id=esc(s.id),key='set:'+id,title=SET_NAMES[s.id]||s.name||'Готовый сет';
 const controls=n
  ?'<div class="card-quantity builder-card-stepper"><button type="button" data-builder-set="'+id+'" data-delta="-1" aria-label="Уменьшить">−</button><span>'+n+'</span><button type="button" data-builder-set="'+id+'" data-delta="1" aria-label="Увеличить">+</button></div>'
  :'<button type="button" class="card-add builder-add-one" data-builder-set="'+id+'" data-delta="1" aria-label="Добавить сет">+</button>';
 return '<article class="builder-card '+(n?'selected':'')+'" data-builder-info="'+key+'" tabindex="0" aria-label="Состав: '+esc(title)+'"><div class="builder-card-photo"><img src="'+setImage(s)+'" alt="'+esc(title)+'" loading="lazy"></div><div class="builder-card-copy"><b>'+esc(title)+'</b><p class="builder-card-description">'+esc(s.description||'Готовый набор роллов для компании или уютного вечера.')+'</p><small>'+setPieces(s)+' шт. · '+setWeight(s)+' г</small><button type="button" class="card-composition builder-card-composition" data-composition="'+key+'"><span aria-hidden="true">✦</span> Состав</button><div class="builder-card-footer"><strong>'+money(setPrice(s))+'</strong>'+controls+'</div></div></article>';
}
function renderBuilder(){
 const filter=state.builderFilter;
 let list=[];
 if(filter==='sets')list=state.sets.filter(s=>s.active!==false).map(builderSetCard);
 else{
  const products=state.products.filter(p=>{
   const c=productCategory(p);
   if(filter==='all')return true;
   if(filter==='rolls')return c==='rolls';
   if(filter==='dogs')return c==='dogs';
   if(filter==='snacks')return c==='snacks';
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
 renderBuilder();toast(delta>0?productKind(p)+' добавлен в сет':productKind(p)+' убран из сета');
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
 renderBuilder();toast(delta>0?'Сет добавлен в конструктор':'Сет убран из конструктора');
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
 $$('.workflow-screen').forEach(x=>x.classList.toggle('active',x.id===screen));
 const activeNav=screen==='confirmationScreen'?'cart':screen.replace('Screen','').replace('basket','cart');
 $$('.bottom-nav button').forEach(x=>x.classList.toggle('active',x.dataset.nav===activeNav));
 $$('.workflow-steps').forEach(group=>$$('.workflow-step',group).forEach((step,index)=>step.classList.toggle('completed',screen==='basketScreen'&&index===0)));
 $('#detailDevice').classList.remove('mobile-active');
 document.body.classList.remove('detail-open');
 document.body.style.overflow='';
}
function returnToCatalogue(){
 state.activeScreen='catalogue';
 $('#detailDevice').classList.remove('mobile-active');
 document.body.classList.remove('detail-open');
 $('.reference-board').classList.remove('workflow-mode');
 $('.catalogue-device').classList.remove('workflow-mode');
 $$('.workflow-screen').forEach(x=>x.classList.remove('active'));
 $$('.bottom-nav button').forEach(x=>x.classList.toggle('active',x.dataset.nav==='catalogue'));
 document.body.style.overflow='';
}
function showHomeScreen(){syncHomeShortcutState();updateStoreHours();activateWorkflow('homeScreen');const home=$('.home-scroll');if(home)home.scrollTop=0;}
function showFavoritesScreen(){renderFavorites();activateWorkflow('favoritesScreen');}
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

function checkoutMapUrl(query){
 const address=String(query||'').trim()||'Социалистическая, 26, район «Остров», Чарышское, Алтайский край';
 const canonical=fullCharyshAddress(address);
 return 'https://yandex.ru/map-widget/v1/?text='+encodeURIComponent(canonical)+'&z=17&lang=ru_RU';
}
function updateDeliveryMap(){
 const street=normalizeDeliveryAddress();
 const fullAddress=fullCharyshAddress(street);
 const frame=$('#checkoutMap'),link=$('#checkoutMapLink'),label=$('#checkoutMapLabel'),address=$('#checkoutMapAddress');
 if(label)label.textContent='АДРЕС ДОСТАВКИ · ЧАРЫШСКОЕ';
 if(address)address.textContent=street?fullAddress:'Чарышское, Алтайский край — добавь улицу и дом';
 if(frame)frame.src=checkoutMapUrl(fullAddress);
 if(link)link.href='https://yandex.ru/maps/?text='+encodeURIComponent(fullAddress);
}
function updateCheckoutFulfillment(mode){
 const delivery=mode==='Доставка',value=delivery?'Доставка':'Самовывоз';
 const hidden=$('#fulfillment');if(hidden)hidden.value=value;
 document.querySelectorAll('[data-fulfillment]').forEach(button=>{
  const active=button.dataset.fulfillment===value;
  button.classList.toggle('active',active);
  button.setAttribute('aria-pressed',active?'true':'false');
 });
 const addressField=$('#deliveryAddressField'),addressInput=$('#deliveryAddress');
 if(addressField)addressField.hidden=!delivery;
 if(addressInput)addressInput.required=delivery;
 const frame=$('#checkoutMap'),label=$('#checkoutMapLabel'),address=$('#checkoutMapAddress'),link=$('#checkoutMapLink');
 if(delivery){
  updateDeliveryMap();
 }else{
  const pickupAddress=state.settings.pickup_address||'Социалистическая, 26, Чарышское';
  if(label)label.textContent='АДРЕС САМОВЫВОЗА';
  if(address)address.textContent=pickupAddress;
  if(frame)frame.src=checkoutMapUrl(pickupAddress);
  if(link)link.href=state.settings.pickup_map_url||('https://yandex.ru/maps/?text='+encodeURIComponent(pickupAddress));
 }
 $('#checkoutNote').textContent=delivery?(state.settings.delivery_note||'Стоимость и возможность доставки подтвердим после получения заказа.'):'Время самовывоза подтвердим отдельно.';
}
const DELIVERY_CITY_PREFIX='Чарышское, Алтайский край';
function formatRussianPhone(value){
 let digits=String(value||'').replace(/\D/g,'');
 if(digits.startsWith('8')||digits.startsWith('7'))digits=digits.slice(1);
 digits=digits.slice(0,10);
 let result='+7';
 if(!digits.length)return '+7 ';
 if(digits.length)result+=' '+digits.slice(0,3);
 if(digits.length>3)result+=' '+digits.slice(3,6);
 if(digits.length>6)result+='-'+digits.slice(6,8);
 if(digits.length>8)result+='-'+digits.slice(8,10);
 return result;
}
function normalizePhoneField(){
 const input=$('#checkoutPhone');if(!input)return '';
 const formatted=formatRussianPhone(input.value);
 if(input.value!==formatted){input.value=formatted;try{input.setSelectionRange(formatted.length,formatted.length);}catch(_){}}
 return formatted;
}
function validCheckoutName(){
 const input=$('#checkoutName');if(!input)return false;
 const value=input.value.trim();
 return Array.from(value.matchAll(/\p{L}/gu)).length>=2&&/^[\p{L}\p{M} .’'-]+$/u.test(value);
}
function validCheckoutPhone(){
 const input=$('#checkoutPhone');if(!input)return false;
 const digits=input.value.replace(/\D/g,'');
 return digits.length===11&&digits.startsWith('7');
}
function setIdentityFieldError(input,errorId,message){
 if(!input)return;
 const field=input.closest('.checkout-field'),error=$('#'+errorId);
 input.classList.add('is-invalid');input.setAttribute('aria-invalid','true');
 if(field)field.classList.add('has-error');
 if(error){error.textContent=message;error.hidden=false;}
}
function clearIdentityFieldError(input,errorId){
 if(!input)return;
 const field=input.closest('.checkout-field'),error=$('#'+errorId);
 input.classList.remove('is-invalid');input.removeAttribute('aria-invalid');
 if(field)field.classList.remove('has-error');
 if(error)error.hidden=true;
}
function validateCheckoutName(showError){
 const input=$('#checkoutName'),valid=validCheckoutName();
 if(valid)clearIdentityFieldError(input,'checkoutNameError');
 else if(showError)setIdentityFieldError(input,'checkoutNameError','Введите имя буквами — минимум две буквы, без цифр.');
 return valid;
}
function validateCheckoutPhone(showError){
 const input=$('#checkoutPhone');normalizePhoneField();
 const valid=validCheckoutPhone();
 if(valid)clearIdentityFieldError(input,'checkoutPhoneError');
 else if(showError)setIdentityFieldError(input,'checkoutPhoneError','Введите 10 цифр номера после +7.');
 return valid;
}
function validateCheckoutIdentity(showError){
 const nameOk=validateCheckoutName(showError),phoneOk=validateCheckoutPhone(showError);
 return nameOk&&phoneOk;
}
function normalizeDeliveryAddress(){
 const input=$('#deliveryAddress');if(!input)return '';
 let raw=String(input.value||'').trim();
 raw=raw.replace(/^Чарышское\s*,\s*Алтайский\s+край\s*,?\s*/i,'');
 raw=raw.replace(/,?\s*Чарышское\s*,?\s*Алтайский\s+край\s*$/i,'').trim();
 const complete=DELIVERY_CITY_PREFIX+(raw?', '+raw:', ');
 if(input.value!==complete){input.value=complete;try{input.setSelectionRange(complete.length,complete.length);}catch(_){}}
 return raw;
}
function fullCharyshAddress(street){
 const clean=String(street||'').trim()
  .replace(/^Чарышское\s*,\s*Алтайский\s+край\s*,?\s*/i,'')
  .replace(/,?\s*Чарышское\s*,?\s*Алтайский\s+край\s*$/i,'')
  .replace(/,?\s*Чарышское\s*$/i,'').trim();
 return clean?clean+', '+DELIVERY_CITY_PREFIX:DELIVERY_CITY_PREFIX;
}
async function sendOrder(e){e.preventDefault();const form=$('#checkoutForm'),error=$('#checkoutError');error.textContent='';normalizePhoneField();const identityOk=validateCheckoutIdentity(true);if(!identityOk){error.textContent='Исправь имя и телефон, отмеченные красной рамкой.';return;}if(!cartCount()){error.textContent='Корзина пуста.';return;}const telegram=tg();if(!telegram?.initData){error.textContent='Открой магазин через Telegram, чтобы отправить заказ.';return;}if($('#fulfillment').value==='Доставка')normalizeDeliveryAddress();const data=new FormData(form),name=String(data.get('name')||'').trim(),phone=String(data.get('phone')||'').trim(),date=String(data.get('pickup_date')||''),time=String(data.get('pickup_time')||''),fulfillment=String(data.get('fulfillment')||'Самовывоз'),address=String(data.get('delivery_address')||'').trim();if(!date||!time){error.textContent='Выбери дату и время получения.';return;}if(fulfillment==='Доставка'&&(!state.settings.delivery_enabled||!address.replace(/^Чарышское, Алтайский край,?\s*/i,'').trim())){error.textContent='Укажи улицу и дом в Чарышском.';return;}if(fulfillment==='Самовывоз'&&state.settings.pickup_enabled===false){error.textContent='Самовывоз сейчас недоступен.';return;}if(fulfillment==='Доставка'&&productTotal()<Number(state.settings.minimum_order||0)){error.textContent='Минимальная сумма доставки — '+money(state.settings.minimum_order)+'.';return;}const notes=[String(data.get('notes')||'').trim(),'Способ получения: '+fulfillment,fulfillment==='Доставка'?'Адрес доставки: '+address:''].filter(Boolean).join('\n');const payload={init_data:telegram.initData,client_order_id:form.dataset.orderId||crypto.randomUUID(),name:name,phone:phone,time:pickupLabel(date,time),notes:notes,items:state.products.filter(p=>qty(p.id)>0).map(p=>({id:p.id,qty:qty(p.id)})),sets:Object.entries(state.setCounts).filter(([,n])=>n>0).map(([id,n])=>({id:id,qty:Number(n)}))};form.dataset.orderId=payload.client_order_id;const button=$('#submitOrder');button.disabled=true;button.textContent='Отправляем…';try{telegram.ready();telegram.expand();const r=await fetch(API+'/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'}),result=await r.json().catch(()=>({}));if(!r.ok||result.ok!==true)throw Error(typeof result.detail==='string'?result.detail:'Сервер не подтвердил заказ.');const submitted={order_id:result.order_id,total:Number(result.total)||productTotal(),time:payload.time,items:payload.items,sets:payload.sets};state.cart={};state.setCounts={};save();renderAll();closeModal('cartModal');form.reset();delete form.dataset.orderId;showConfirmation(submitted);}catch(err){error.textContent=err.message||'Не удалось отправить заказ.';}finally{button.disabled=!cartCount();button.textContent='Отправить заказ ↗';}}
async function checkAdminEntry(initData){
 const link=$('#adminPanelEntry');if(!link||!initData)return;
 try{
  const response=await fetch(API+'/api/admin/check',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({init_data:initData}),cache:'no-store'
  });
  if(!response.ok)return;
  const result=await response.json();
  if(result.is_admin===true){link.hidden=false;link.setAttribute('aria-hidden','false');}
 }catch(error){console.warn('Admin entry check failed',error);}
}
function updateStoreHours(){
 const dayNames={Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:7};
 let parts;
 try{
  parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Barnaul',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
 }catch(_){
  parts=new Intl.DateTimeFormat('en-US',{weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
 }
 const value=Object.fromEntries(parts.map(part=>[part.type,part.value]));
 const day=dayNames[value.weekday]||0;
 const hour=Number(value.hour)||0,minute=Number(value.minute)||0;
 const total=hour*60+minute;
 const workingDay=[1,2,4,5,6].includes(day);
 const isOpen=workingDay&&total>=12*60&&total<20*60;
 const dot=$('#homeHoursDot'),label=$('#homeHoursStatus');
 if(dot){dot.classList.toggle('is-open',isOpen);dot.classList.toggle('is-closed',!isOpen);}
 if(label){label.textContent=isOpen?'Мы работаем':'Не работаем';label.classList.toggle('is-open',isOpen);label.classList.toggle('is-closed',!isOpen);}
}
function syncHomeShortcutState(){
 document.querySelectorAll('[data-home-filter]').forEach(button=>{
  const selected=button.dataset.homeFilter===state.filter;
  button.classList.toggle('active',selected);
  button.setAttribute('aria-pressed',selected?'true':'false');
 });
}
function updateHomePhone(settings){
 const phone=String(settings?.phone||'+7 923 000-58-57').trim();
 const digits=phone.replace(/\D/g,'');
 const dial=phone.startsWith('+')?'+'+digits:(digits.length===11&&digits.startsWith('8')?'+7'+digits.slice(1):digits.length===11&&digits.startsWith('7')?'+'+digits:digits.length===10?'+7'+digits:'+'+digits);
 const link=$('#homePhoneOrder'),text=$('#homePhoneText');
 if(link){link.href='tel:'+dial;link.setAttribute('aria-label','Позвонить '+phone);}
 if(text)text.textContent=phone;
}
async function load(){let fallback={products:[]};try{fallback=await (await fetch('./assets/local-catalog-fallback.json',{cache:'force-cache'})).json();}catch(e){}const results=await Promise.allSettled([apiGet('/api/menu'),apiGet('/api/site-content'),apiGet('/api/store-settings')]);const local=new Map((fallback.products||[]).map(p=>[p.id,p]));state.products=results[0].status==='fulfilled'?results[0].value.filter(p=>p.active!==false).map(p=>({...local.get(p.id),...p,photo:p.photo||local.get(p.id)?.photo||''})):fallback.products||[];state.sets=results[1].status==='fulfilled'?(results[1].value.sets||[]).filter(s=>s.active!==false):[];state.settings=results[2].status==='fulfilled'?results[2].value:{};updateHomePhone(state.settings);updateStoreHours();syncHomeShortcutState();if(!window.__tihiyHoursTimer)window.__tihiyHoursTimer=setInterval(updateStoreHours,30000);const pickupHome=$('#homePickupAddress');if(pickupHome)pickupHome.textContent=state.settings.pickup_address||'Социалистическая, 26, Чарышское';loadSaved();for(const id of Object.keys(state.cart)){const p=find(id);if(!p){delete state.cart[id];continue;}if(stock(p)!==null)state.cart[id]=Math.min(stock(p),qty(id));}renderAll();const first=find('philadelphia')||state.products[0];if(first)detail(first,false);const app=tg();if(app){app.ready();app.expand();if(app.initData)checkAdminEntry(app.initData);}const settings=state.settings,phone=settings.phone||'+7 923 000-58-57',digits=phone.replace(/\D/g,'');$('#headerPhone')?.setAttribute('href','tel:+7'+digits.slice(-10));$('#footerPhone')?.setAttribute('href','tel:+7'+digits.slice(-10));}
document.addEventListener('click',e=>{const composition=e.target.closest('[data-composition]');if(composition){showBuilderInfo(composition.dataset.composition);return;}const b=e.target.closest('button');if(!b)return;if(b.dataset.filter){state.filter=b.dataset.filter;$$('.category-tile').forEach(x=>x.classList.toggle('active',x===b));renderCatalog();return;}if(b.dataset.cardQty){const id=b.dataset.id,delta=Number(b.dataset.cardQty)||0;if(id.startsWith('set:'))changeSetCart(id.slice(4),delta);else changeCart(id,delta);return;}if(b.dataset.add){const id=b.dataset.add;if(id.startsWith('set:'))addSet(state.sets.find(s=>s.id===id.slice(4)));else addProduct(find(id),1);return;}if(b.dataset.fav){const id=b.dataset.fav,p=id.startsWith('set:')?{set:true}:find(id),added=!state.favorites.has(id);if(added)state.favorites.add(id);else state.favorites.delete(id);save();renderAll();toast(productKind(p)+(added?' добавлен в избранное':' удалён из избранного'));return;}if(b.dataset.cartQty){changeCart(b.dataset.id,Number(b.dataset.cartQty));return;}if(b.dataset.cartRemove){changeCart(b.dataset.cartRemove,-qty(b.dataset.cartRemove));return;}if(b.dataset.builderFilter!==undefined){state.builderFilter=b.dataset.builderFilter;renderBuilder();return;}if(b.dataset.builderProduct){changeBuilderProduct(b.dataset.builderProduct,Number(b.dataset.delta)||0);return;}if(b.dataset.builderSet){changeBuilderSet(b.dataset.builderSet,Number(b.dataset.delta)||0);return;}if(b.hasAttribute('data-workflow-back')){returnToCatalogue();return;}if(b.id==='builderAddToCart'){addBuilderToCart();return;}if(b.id==='cartCheckout'){openModal('cartModal');return;}if(b.id==='cartKeepShopping'){returnToCatalogue();return;}if(b.id==='confirmationHome'){showHomeScreen();return;}if(b.hasAttribute('data-open-cart')){showCartScreen();return;}if(b.hasAttribute('data-open-favorites')){openModal('favoritesModal');return;}if(b.dataset.close){closeModal(b.dataset.close);return;}if(b.dataset.photoIndex!==undefined){showGalleryPhoto(Number(b.dataset.photoIndex));return;}if(b.hasAttribute('data-gallery-next')){showGalleryPhoto(state.photoIndex+1);return;}if(b.id==='detailBack'){document.body.classList.remove('detail-open');$('#detailDevice').classList.remove('mobile-active');return;}if(b.id==='detailMinus'){changeDetail(-1);return;}if(b.id==='detailPlus'){changeDetail(1);return;}if(b.id==='detailAdd'){addSelected();return;}if(b.id==='detailFavorite'&&state.selected){const item=state.selected,id=item.id,added=!state.favorites.has(id);if(added)state.favorites.add(id);else state.favorites.delete(id);save();renderBadges();b.textContent=added?'♥':'♡';toast(productKind(item)+(added?' добавлен в избранное':' удалён из избранного'));return;}if(b.id==='detailShare'){if(navigator.share)navigator.share({title:state.selected?.name||'Тихий ролл',url:location.href}).catch(()=>{});else toast('Поделись ссылкой на магазин.');return;}if(b.id==='filterOpen'||b.classList.contains('menu-trigger')){openModal('filtersModal');return;}if(b.dataset.filterOption){state.filter=b.dataset.filterOption;renderFilterOptions();return;}if(b.id==='applyFilters'){renderCatalog();closeModal('filtersModal');return;}if(b.dataset.removeFav){state.favorites.delete(b.dataset.removeFav);save();renderFavorites();renderBadges();return;}if(b.dataset.fulfillment){updateCheckoutFulfillment(b.dataset.fulfillment);return;}if(b.hasAttribute('data-home-catalog')){state.filter='all';returnToCatalogue();$$('.category-tile').forEach(x=>x.classList.remove('active'));renderCatalog();if($('#catalogue'))$('#catalogue').scrollTop=0;return;}if(b.hasAttribute('data-home-builder')){showBuilderScreen();return;}if(b.hasAttribute('data-home-newyear')){const promo=state.sets.find(row=>row.id==='newyear')||state.sets[0];if(promo)setDetail(promo);else toast('Сет скоро появится в меню.');return;}if(b.dataset.homeFilter){state.filter=b.dataset.homeFilter;syncHomeShortcutState();returnToCatalogue();$$('.category-tile').forEach(x=>x.classList.toggle('active',x.dataset.filter===state.filter));renderCatalog();if($('#catalogue'))$('#catalogue').scrollTop=0;return;}if(b.dataset.nav==='home'){showHomeScreen();return;}if(b.dataset.nav==='favorites'){showFavoritesScreen();return;}if(b.dataset.nav==='catalogue'){returnToCatalogue();return;}if(b.dataset.nav==='builder'){showBuilderScreen();return;}if(b.dataset.nav==='cart'){showCartScreen();return;}});
const galleryStage=$('.detail-image-stage');
let galleryTouchStart=null;
if(galleryStage){
 galleryStage.addEventListener('touchstart',event=>{
  if(event.target.closest('button,a')){galleryTouchStart=null;return;}
  const touch=event.changedTouches[0];galleryTouchStart={x:touch.clientX,y:touch.clientY};
 },{passive:true});
 galleryStage.addEventListener('touchend',event=>{
  if(!galleryTouchStart)return;
  const touch=event.changedTouches[0],dx=touch.clientX-galleryTouchStart.x,dy=touch.clientY-galleryTouchStart.y;
  galleryTouchStart=null;
  if(Math.abs(dx)>46&&Math.abs(dx)>Math.abs(dy)*1.2){
   showGalleryPhoto(state.photoIndex+(dx<0?1:-1));
  }
 },{passive:true});
}
function openProductFromGrid(e){if(e.target.closest('button'))return;const el=e.target.closest('[data-card]');if(!el)return;const id=el.dataset.card;if(id.startsWith('set:')){const s=state.sets.find(x=>x.id===id.slice(4));if(s)setDetail(s);}else detail(find(id));}
function openProductInfoFromGrid(e){if(e.target.closest('button'))return;const el=e.target.closest('[data-card]');if(!el)return;showBuilderInfo(el.dataset.card);}
$('#builderGrid').addEventListener('click',event=>{
 if(event.target.closest('button'))return;
 const target=event.target.closest('[data-builder-info]');if(target)showBuilderInfo(target.dataset.builderInfo);
});
$('#builderGrid').addEventListener('keydown',event=>{
 if(event.key!=='Enter'&&event.key!==' ')return;
 const target=event.target.closest('[data-builder-info]');if(!target||event.target.closest('button'))return;
 event.preventDefault();showBuilderInfo(target.dataset.builderInfo);
});
$('#catalogueGrid').addEventListener('click',openProductFromGrid);
$('#homePopularGrid')?.addEventListener('click',openProductInfoFromGrid);
$('#favoritesGrid')?.addEventListener('click',openProductInfoFromGrid);
$('#sortSelect').addEventListener('change',e=>{state.sort=e.target.value;renderCatalog();});
$('#catalogSearch').addEventListener('input',e=>{state.search=e.target.value.trim().toLowerCase();renderCatalog();});
$('#pickupDate').addEventListener('change',refreshTimes);
const checkoutName=$('#checkoutName'),checkoutPhone=$('#checkoutPhone'),deliveryAddress=$('#deliveryAddress');
checkoutPhone.value=formatRussianPhone(checkoutPhone.value||'+7 ');
checkoutPhone.addEventListener('focus',()=>{if(!checkoutPhone.value||checkoutPhone.value.trim()==='')checkoutPhone.value='+7 ';if(checkoutPhone.value.trim()==='+7'){try{checkoutPhone.setSelectionRange(checkoutPhone.value.length,checkoutPhone.value.length);}catch(_){}}});
checkoutPhone.addEventListener('beforeinput',event=>{
 if(!event.inputType?.startsWith('delete'))return;
 const start=checkoutPhone.selectionStart??0,end=checkoutPhone.selectionEnd??0;
 if(start<=2&&end<=2)event.preventDefault();
});
checkoutPhone.addEventListener('input',()=>{normalizePhoneField();if(checkoutPhone.classList.contains('is-invalid'))validateCheckoutPhone(true);});
checkoutPhone.addEventListener('blur',()=>validateCheckoutPhone(true));
checkoutName.addEventListener('input',()=>{if(checkoutName.classList.contains('is-invalid'))validateCheckoutName(true);});
checkoutName.addEventListener('blur',()=>validateCheckoutName(true));
deliveryAddress.value=DELIVERY_CITY_PREFIX+', ';
deliveryAddress.addEventListener('beforeinput',event=>{
 if(!event.inputType?.startsWith('delete'))return;
 const start=deliveryAddress.selectionStart??0,end=deliveryAddress.selectionEnd??0;
 if(start<DELIVERY_CITY_PREFIX.length&&end<=DELIVERY_CITY_PREFIX.length)event.preventDefault();
});
deliveryAddress.addEventListener('input',updateDeliveryMap);
deliveryAddress.addEventListener('change',updateDeliveryMap);
$('#checkoutForm').addEventListener('submit',sendOrder);
$$('.modal-layer').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModal(m.id);}));
window.addEventListener('keydown',e=>{if(e.key==='Escape'){['cartModal','favoritesModal','filtersModal','builderInfoModal'].forEach(closeModal);$('#detailDevice').classList.remove('mobile-active');}});
load().catch(e=>{console.error(e);toast('Не удалось загрузить меню.');});
})();