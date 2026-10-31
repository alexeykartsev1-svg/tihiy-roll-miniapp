(() => {
  'use strict';
  const API = 'https://tihiy-roll-order-api.onrender.com';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const DAY_NAMES = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  const SET_NAMES = {solo:'Сет «На одного»',duo:'Сет «Вечер вдвоём»',party:'Сет «Компания»',newyear:'Новогодний сет'};
  const SET_PHOTOS = {solo:'./assets/set-solo.webp',duo:'./assets/set-duo.webp',party:'./assets/set-party.webp',newyear:'./assets/set-party.webp'};
  const state = {products:[],categories:[],sets:[],settings:{},cart:{},setCounts:{},favorites:new Set(),filter:'all',search:'',sort:'popular',builder:{},currentProduct:null,gallery:[],galleryIndex:0,toastTimer:null};
  const money = value => `${Math.round(Number(value)||0).toLocaleString('ru-RU')} ₽`;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const safeImage = value => typeof value === 'string' && (value.startsWith('https://') || value.startsWith('data:image/')) ? value : '';
  const webApp = () => window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  function toast(message) {
    const node = $('#toast'); if (!node) return;
    node.textContent = message; node.classList.add('show');
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
  }
  async function getJson(path) {
    const response = await fetch(API + path, {cache:'no-store'});
    if (!response.ok) throw new Error(`Сервер ответил ${response.status}`);
    return response.json();
  }
  function readStorage(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value ?? fallback; } catch { return fallback; } }
  function saveStorage() {
    try { localStorage.setItem('tihiy-v3-cart', JSON.stringify(state.cart)); localStorage.setItem('tihiy-v3-favorites', JSON.stringify([...state.favorites])); localStorage.setItem('tihiy-v3-set-counts', JSON.stringify(state.setCounts)); } catch { /* storage may be disabled */ }
  }
  function productById(id) { return state.products.find(product => product.id === id); }
  function productImage(product) {
    const gallery = Array.isArray(product?.gallery) ? product.gallery.map(safeImage).filter(Boolean) : [];
    return safeImage(product?.photo) || gallery[0] || '';
  }
  function productPhotos(product) {
    const all = [safeImage(product?.photo), ...(Array.isArray(product?.gallery) ? product.gallery.map(safeImage) : [])].filter(Boolean);
    return [...new Set(all)].slice(0,6);
  }
  function qtyOf(id) { return Number(state.cart[id] || 0); }
  function cartTotal() { return state.products.reduce((sum,p) => sum + p.price * qtyOf(p.id), 0); }
  function cartCount() { return Object.values(state.cart).reduce((sum,qty) => sum + Number(qty || 0), 0); }
  function stockLeft(product) { return product.stock == null ? null : Math.max(0, Number(product.stock) || 0); }
  function canAdd(product, amount=1) { const stock = stockLeft(product); return !stock || qtyOf(product.id) + amount <= stock; }
  function adjustProduct(id, delta) {
    const product = productById(id); if (!product) return;
    const next = qtyOf(id) + delta;
    if (next < 0) return;
    const stock = stockLeft(product);
    if (delta > 0 && stock !== null && next > stock) { toast(stock === 0 ? 'Эта позиция закончилась.' : `В наличии осталось: ${stock} шт.`); return; }
    if (next > 0) state.cart[id] = next; else delete state.cart[id];
    // Manual edits turn a set into ordinary menu items; the server then receives only item quantities.
    state.setCounts = {};
    saveStorage(); renderAll();
  }
  function addSet(setRow) {
    if (!setRow || setRow.active === false) return;
    const count = Number(state.setCounts[setRow.id] || 0);
    if (count >= 20) { toast('В одном заказе можно выбрать не более 20 одинаковых сетов.'); return; }
    if (setRow.stock != null && count >= Number(setRow.stock)) { toast('Этот сет закончился.'); return; }
    const components = Array.isArray(setRow.items) ? setRow.items : [];
    if (!components.length) { toast('Состав этого сета пока не заполнен.'); return; }
    for (const item of components) {
      const product = productById(item.id); if (!product) { toast('В составе сета есть временно недоступная позиция.'); return; }
      const stock = stockLeft(product), add = Number(item.qty || 0);
      if (qtyOf(product.id) + add > 99) { toast('Превышено максимальное количество товара в заказе.'); return; }
      if (stock !== null && qtyOf(product.id) + add > stock) { toast(`Недостаточно товара «${product.name}».`); return; }
    }
    components.forEach(item => { state.cart[item.id] = qtyOf(item.id) + Number(item.qty || 0); });
    state.setCounts[setRow.id] = count + 1; saveStorage(); renderAll(); toast(`${SET_NAMES[setRow.id] || 'Сет'} добавлен в корзину.`);
  }
  function setImage(setRow) { return safeImage(setRow.image) || (Array.isArray(setRow.photos) && safeImage(setRow.photos[0])) || SET_PHOTOS[setRow.id] || ''; }
  function setPrice(setRow) { return (setRow.items || []).reduce((sum,item) => sum + (productById(item.id)?.price || 0) * Number(item.qty || 0), 0); }
  function setCompositionText(setRow) { return (setRow.items || []).map(item => { const p=productById(item.id); return p ? `${p.name}${Number(item.qty)>1?' × '+item.qty:''}` : ''; }).filter(Boolean).join(' · '); }
  function renderCategoryTiles() {
    const root = $('#categoryGrid');
    const descriptors = [
      {id:'classic',name:'Классические роллы',icon:'🍣',sub:'Классика в любимом исполнении'},
      {id:'warm',name:'Тёплые и мясные',icon:'🔥',sub:'Сытные и румяные'},
      {id:'dogs',name:'Азиатские хот-доги',icon:'🌭',sub:'Яркий стритфуд'},
      {id:'snacks',name:'Закуски',icon:'🍤',sub:'К заказу и в компанию'}
    ];
    const available = descriptors.filter(row => state.products.some(p => p.cat === row.id));
    if (!available.length) { root.innerHTML = '<div class="loading-card">Категории появятся вместе с товарами в меню.</div>'; return; }
    root.innerHTML = available.map(row => {
      const product = state.products.find(p => p.cat === row.id);
      const photo = productImage(product);
      const category = state.categories.find(c => c.id === row.id);
      return `<button class="category-card" type="button" data-category="${row.id}">${photo?`<img src="${photo}" alt="" loading="lazy">`:''}<span class="category-card-icon">${escapeHtml(category?.icon || row.icon)}</span><span class="category-card-copy"><b>${escapeHtml(category?.name || row.name)}</b><small>${escapeHtml(row.sub)}</small></span></button>`;
    }).join('');
  }
  function productCard(product) {
    const photo = productImage(product);
    const stock = stockLeft(product);
    const badge = product.badge ? `<span class="product-badge">${escapeHtml(product.badge)}</span>` : '';
    const fav = state.favorites.has(product.id);
    const count = qtyOf(product.id);
    const meta = [product.weight, product.pieces ? `${product.pieces} шт.` : ''].filter(Boolean).map(x=>`<span>${escapeHtml(x)}</span>`).join('');
    return `<article class="product-card" data-product-card="${escapeHtml(product.id)}"><div class="product-media">${photo?`<img src="${photo}" alt="${escapeHtml(product.name)}" loading="lazy">`:''}${badge}<button class="favorite-button ${fav?'active':''}" type="button" data-favorite="${escapeHtml(product.id)}" aria-label="${fav?'Убрать из избранного':'Добавить в избранное'}">${fav?'♥':'♡'}</button></div><div class="product-copy"><div class="product-title-row"><h3 class="product-title">${escapeHtml(product.name)}</h3></div><p class="product-description">${escapeHtml(product.desc || product.details || 'Приготовим свежим к выбранному времени.')}</p><div class="product-meta">${meta}</div><div class="product-bottom"><strong class="product-price">${money(product.price)}</strong><div class="product-actions">${count?`<span class="quantity-control"><button type="button" data-qty="-1" data-id="${escapeHtml(product.id)}">−</button><output>${count}</output><button type="button" data-qty="1" data-id="${escapeHtml(product.id)}" ${stock!==null&&count>=stock?'disabled':''}>+</button></span>`:`<button class="details-button" type="button" data-details="${escapeHtml(product.id)}">Состав</button><button class="details-button" type="button" data-qty="1" data-id="${escapeHtml(product.id)}" ${stock===0?'disabled':''}>+ Добавить</button>`}</div></div>${stock!==null?`<small class="stock-label ${stock===0?'sold-out':''}">${stock===0?'Нет в наличии':`Осталось: ${stock} шт.`}</small>`:''}</div></article>`;
  }
  function getFilteredProducts() {
    let rows = [...state.products];
    if (state.filter !== 'all') rows = rows.filter(p => p.cat === state.filter);
    if (state.search) rows = rows.filter(p => `${p.name} ${p.desc||''} ${p.details||''}`.toLocaleLowerCase('ru').includes(state.search));
    if (state.sort === 'price-asc') rows.sort((a,b)=>a.price-b.price);
    if (state.sort === 'price-desc') rows.sort((a,b)=>b.price-a.price);
    if (state.sort === 'name') rows.sort((a,b)=>a.name.localeCompare(b.name,'ru'));
    return rows;
  }
  function renderFilters() {
    const root = $('#filterRow');
    const rows = [{id:'all',name:'Всё меню'},...state.categories.filter(row=>row.id!=='sets' && state.products.some(p=>p.cat===row.id))];
    root.innerHTML = rows.map(row=>`<button class="filter-pill ${state.filter===row.id?'active':''}" type="button" data-filter="${escapeHtml(row.id)}">${escapeHtml(row.name)}</button>`).join('');
  }
  function renderProducts() {
    const rows = getFilteredProducts();
    $('#productGrid').innerHTML = rows.length ? rows.map(productCard).join('') : '';
    $('#emptyState').hidden = rows.length > 0;
    $('#menuCount').textContent = `${rows.length} ${rows.length===1?'позиция':rows.length>=2&&rows.length<=4?'позиции':'позиций'}`;
  }
  function renderFeatured() {
    const rows = [...state.products].filter(p => p.active !== false).sort((a,b) => (b.badge?1:0)-(a.badge?1:0) || Number(a.sort_order||0)-Number(b.sort_order||0)).slice(0,4);
    $('#featuredGrid').innerHTML = rows.length ? rows.map(productCard).join('') : '<div class="loading-card">Популярные блюда появятся здесь.</div>';
  }
  function renderSets() {
    const rows = state.sets.filter(set => set.active !== false);
    $('#setsGrid').innerHTML = rows.length ? rows.map(set => {
      const photo = setImage(set), stock = set.stock == null ? null : Math.max(0,Number(set.stock)||0);
      const price = setPrice(set), composition = setCompositionText(set);
      return `<article class="set-card ${stock===0?'out-of-stock':''}">${photo?`<img class="set-image" src="${photo}" alt="${escapeHtml(SET_NAMES[set.id]||'Готовый сет')}" loading="lazy">`:''}<div class="set-card-main"><div class="set-kicker">ГОТОВОЕ СОЧЕТАНИЕ</div><h3>${escapeHtml(SET_NAMES[set.id] || set.name || 'Фирменный сет')}</h3><p>${escapeHtml(set.description || 'Подборка любимых блюд для уютного вечера.')}</p><div class="set-components">${escapeHtml(composition)}</div><strong class="set-price">${money(price)}</strong></div><div class="set-card-actions"><button class="set-composition" type="button" data-set-details="${escapeHtml(set.id)}">Состав сета</button><button class="set-add" type="button" data-add-set="${escapeHtml(set.id)}" ${stock===0?'disabled':''}>${stock===0?'Нет в наличии':'Добавить сет ↗'}</button>${stock!==null?`<span class="set-stock">Осталось: ${stock}</span>`:''}</div></article>`;
    }).join('') : '<div class="loading-card">Готовые сеты скоро появятся.</div>';
  }
  function renderBuilder() {
    const rows = state.products.filter(p => p.cat !== 'sets').slice(0,10);
    $('#builderProducts').innerHTML = rows.length ? rows.map(p=>`<div class="builder-product"><img src="${productImage(p)}" alt="" loading="lazy"><span class="builder-product-copy"><b>${escapeHtml(p.name)}</b><small>${money(p.price)}</small></span><span class="builder-qty"><button type="button" data-builder-qty="-1" data-id="${escapeHtml(p.id)}">−</button><output>${Number(state.builder[p.id]||0)}</output><button type="button" data-builder-qty="1" data-id="${escapeHtml(p.id)}">+</button></span></div>`).join('') : '<span>Пока нет доступных блюд.</span>';
    const total = rows.reduce((sum,p)=>sum+p.price*Number(state.builder[p.id]||0),0);
    $('#builderTotal').textContent = money(total);
    $('#addCustomSet').disabled = total <= 0;
  }
  function renderCart() {
    const entries = Object.entries(state.cart).filter(([,qty])=>Number(qty)>0).map(([id,qty])=>({product:productById(id),qty:Number(qty)})).filter(x=>x.product);
    $('#cartLines').innerHTML = entries.length ? entries.map(({product,qty})=>`<div class="cart-line"><img src="${productImage(product)}" alt="" loading="lazy"><span class="cart-line-copy"><b>${escapeHtml(product.name)}</b><small>${money(product.price)} · ${qty} шт.</small><span class="quantity-control"><button type="button" data-cart-qty="-1" data-id="${escapeHtml(product.id)}">−</button><output>${qty}</output><button type="button" data-cart-qty="1" data-id="${escapeHtml(product.id)}">+</button></span></span><strong class="cart-line-price">${money(product.price*qty)}</strong></div>`).join('') : '<div class="empty-cart">Корзина пока пуста.<br>Выбери что-нибудь вкусное в меню.</div>';
    const sets = Object.entries(state.setCounts).filter(([,qty])=>qty>0).map(([id,qty])=>`${SET_NAMES[id]||'Сет'} × ${qty}`);
    $('#cartSetSummary').textContent = sets.length ? 'В корзине отмечено: ' + sets.join(' · ') : '';
    const count = cartCount(), total = cartTotal();
    $('#dockCount').textContent = count ? `${count} шт. в корзине` : 'Корзина пуста';
    $('#dockTotal').textContent = count ? `Сумма заказа · ${money(total)}` : 'Добавь что-нибудь вкусное';
    $('#cartGrandTotal').textContent = money(total);
    $('#cartDock').classList.toggle('has-items', count > 0);
  }
  function renderFavorites() {
    const rows = [...state.favorites].map(productById).filter(Boolean);
    $('#favoriteBadge').textContent = String(rows.length); $('#mobileFavoriteBadge').textContent = String(rows.length);
    $('#favoritesList').innerHTML = rows.length ? rows.map(p=>`<div class="favorite-row"><img src="${productImage(p)}" alt=""><span><b>${escapeHtml(p.name)}</b><small>${money(p.price)}</small></span><button type="button" data-favorite="${escapeHtml(p.id)}">Убрать</button><button type="button" data-qty="1" data-id="${escapeHtml(p.id)}">Добавить</button></div>`).join('') : '<div class="empty-cart">Пока ничего не сохранено.<br>Нажми на сердечко в карточке блюда.</div>';
  }
  function renderAll() { renderCategoryTiles(); renderFilters(); renderFeatured(); renderProducts(); renderSets(); renderBuilder(); renderCart(); renderFavorites(); }

  function openModal(id) { const node=$('#'+id); if (!node) return; node.classList.add('show'); node.setAttribute('aria-hidden','false'); document.body.style.overflow='hidden'; if(id==='cartModal'){renderCart(); prepareCheckout();} if(id==='favoritesModal')renderFavorites(); if(id==='ordersModal')loadOrders(); }
  function closeModal(id) { const node=$('#'+id); if(!node)return; node.classList.remove('show'); node.setAttribute('aria-hidden','true'); if (!$('.modal-layer.show')) document.body.style.overflow=''; }
  function showProduct(id) {
    const product=productById(id); if(!product)return;
    state.currentProduct=product; state.gallery=productPhotos(product); state.galleryIndex=0;
    if(!state.gallery.length) state.gallery=[''];
    updateGallery();
    $('#productModalTitle').textContent=product.name; $('#modalProductDesc').textContent=product.desc||'';
    $('#modalProductDetails').textContent=product.details||product.desc||'Свежеприготовленное блюдо.';
    $('#modalProductPrice').textContent=money(product.price);
    const meta=[product.weight,product.pieces?`${product.pieces} шт.`:''].filter(Boolean);
    $('#modalProductMeta').innerHTML=meta.map(x=>`<span>${escapeHtml(x)}</span>`).join('');
    const stock=stockLeft(product), add=$('#modalAddButton');
    add.disabled=stock===0 || (stock!==null&&qtyOf(product.id)>=stock);
    add.textContent=stock===0?'Нет в наличии':'Добавить в корзину ↗';
    openModal('productModal');
  }
  function updateGallery() {
    const photo=state.gallery[state.galleryIndex]||'';
    $('#modalProductPhoto').src=photo; $('#modalProductPhoto').alt=state.currentProduct?.name||'';
    $('#galleryLabel').textContent=`${String(state.galleryIndex+1).padStart(2,'0')} / ${String(state.gallery.length).padStart(2,'0')}`;
    const multiple=state.gallery.length>1; $('#galleryPrev').hidden=!multiple; $('#galleryNext').hidden=!multiple;
  }
  function moveGallery(delta) { if(!state.gallery.length)return; state.galleryIndex=(state.galleryIndex+delta+state.gallery.length)%state.gallery.length; updateGallery(); }

  function updateFulfillmentUI() {
    const delivery=$('#fulfillment').value==='Доставка';
    $('#deliveryAddressField').hidden=!delivery;
    if(delivery) $('#checkoutNote').textContent=state.settings.delivery_note || 'Стоимость и возможность доставки подтвердим отдельно после получения заказа.';
    else $('#checkoutNote').textContent='После отправки мы получим заказ в Telegram и отдельно подтвердим время выдачи.';
  }
  function localDateString(date) { const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,'0'),d=String(date.getDate()).padStart(2,'0'); return `${y}-${m}-${d}`; }
  function hoursFor(date) {
    const rows=state.settings.weekly_hours||[]; const row=rows.find(item=>item.day===DAY_NAMES[date.getDay()]);
    if(row)return row;
    const defaults={day:DAY_NAMES[date.getDay()],open:'12:00',close:'21:00',closed:[0,3].includes(date.getDay())}; return defaults;
  }
  function findInitialDate() {
    const now=new Date(); const nowMinutes=now.getHours()*60+now.getMinutes();
    for(let i=0;i<14;i++){const date=new Date(now);date.setDate(now.getDate()+i);const hours=hoursFor(date);const close=String(hours.close||'').split(':').map(Number);const closeMinutes=close.length===2?close[0]*60+close[1]:0;const alreadyClosed=i===0&&closeMinutes>0&&nowMinutes>=closeMinutes;if(!alreadyClosed&&!hours.closed&&hours.open&&hours.close)return date;}
    return now;
  }
  async function updatePickupTimes() {
    const dateValue=$('#pickupDate').value; const select=$('#pickupTime'); select.innerHTML='<option value="">Загружаем время…</option>';
    if(!dateValue){select.innerHTML='<option value="">Выбери дату</option>';return;}
    const parts=dateValue.split('-').map(Number); const date=new Date(parts[0],parts[1]-1,parts[2]); const hours=hoursFor(date);
    if(hours.closed || !hours.open || !hours.close){select.innerHTML='<option value="">В этот день выходной</option>';return;}
    const toMinutes=value=>{const [h,m]=String(value).split(':').map(Number);return h*60+m;};
    const start=toMinutes(hours.open), end=toMinutes(hours.close), unavailable=new Set();
    try { const availability=await getJson('/api/availability?date='+encodeURIComponent(dateValue)); (availability.unavailable_times||[]).forEach(t=>unavailable.add(t)); } catch { /* the server validates the final slot on order */ }
    const now=new Date(); const sameDay=dateValue===localDateString(now); const options=[];
    for(let m=start;m<end;m+=30){const time=String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');if(sameDay&&m<=now.getHours()*60+now.getMinutes()+30)continue;options.push({time,disabled:unavailable.has(time)});}
    select.innerHTML='<option value="">Выбери время</option>'+options.map(row=>`<option value="${row.time}" ${row.disabled?'disabled':''}>${row.time}${row.disabled?' — занято':''}</option>`).join('');
    if(!options.length)select.innerHTML='<option value="">Нет доступного времени</option>';
  }
  function prepareCheckout() {
    const date=$('#pickupDate'); if(!date.value){const initial=findInitialDate(); date.min=localDateString(new Date()); date.value=localDateString(initial);}
    $('#pickupTime').innerHTML='<option value="">Загружаем время…</option>'; updatePickupTimes(); updateFulfillmentUI();
    $('#submitOrder').disabled=cartCount()===0;
  }
  function getPickupLabel(dateValue,time) {
    const [y,m,d]=dateValue.split('-').map(Number); const date=new Date(y,m-1,d); const day=localDateString(date)===localDateString(new Date())?'Сегодня':localDateString(date)===localDateString(new Date(Date.now()+86400000))?'Завтра':DAY_NAMES[date.getDay()];
    return `${day} (${dateValue}) в ${time}`;
  }
  async function submitOrder(event) {
    event.preventDefault(); const form=$('#checkoutForm'), data=new FormData(form), error=$('#checkoutError'); error.textContent='';
    if(!cartCount()){error.textContent='Сначала добавь блюда в корзину.';return;}
    const telegram=webApp();
    if(!telegram || !telegram.initData){error.textContent='Для отправки заказа открой магазин через Telegram — кнопкой приложения или из чата с ботом. В обычном браузере можно просматривать меню и собирать корзину.';return;}
    const name=String(data.get('name')||'').trim(), phone=String(data.get('phone')||'').trim(), dateValue=String(data.get('pickup_date')||''), timeValue=String(data.get('pickup_time')||''), fulfillment=String(data.get('fulfillment')||'Самовывоз'), address=String(data.get('delivery_address')||'').trim();
    if(!name||phone.replace(/\D/g,'').length<10||!dateValue||!timeValue){error.textContent='Проверь имя, номер телефона, дату и время.';return;}
    if(fulfillment==='Доставка' && (!state.settings.delivery_enabled || !address)){error.textContent='Для доставки укажи адрес. Возможность доставки подтвердим отдельно.';return;}
    if(fulfillment==='Самовывоз' && state.settings.pickup_enabled===false){error.textContent='Самовывоз сейчас недоступен. Выбери доставку.';return;}
    if(fulfillment==='Доставка' && cartTotal()<Number(state.settings.minimum_order||0)){error.textContent=`Минимальная сумма доставки — ${money(state.settings.minimum_order)}.`;return;}
    const items=Object.entries(state.cart).filter(([,qty])=>Number(qty)>0).map(([id,qty])=>({id,qty:Number(qty)}));
    if(items.length>20){error.textContent='В заказе может быть не более 20 разных позиций.';return;}
    const notes=[String(data.get('notes')||'').trim(),`Способ получения: ${fulfillment}`,fulfillment==='Доставка'?`Адрес доставки: ${address}`:''].filter(Boolean).join('\n');
    const payload={name,phone,time:getPickupLabel(dateValue,timeValue),notes,items,sets:Object.entries(state.setCounts).filter(([,qty])=>Number(qty)>0).map(([id,qty])=>({id,qty:Number(qty)})),init_data:telegram.initData,client_order_id:form.dataset.clientOrderId||crypto.randomUUID()};
    form.dataset.clientOrderId=payload.client_order_id;
    const button=$('#submitOrder'); button.disabled=true; button.textContent='Отправляем заказ…';
    try {
      telegram.ready(); telegram.expand();
      const response=await fetch(API+'/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});
      const result=await response.json().catch(()=>({}));
      if(!response.ok || result.ok!==true) throw new Error(typeof result.detail==='string'?result.detail:(result.message||'Сервер не подтвердил отправку заказа.'));
      state.cart={}; state.setCounts={}; saveStorage(); renderAll(); closeModal('cartModal'); form.reset(); delete form.dataset.clientOrderId;
      toast(`Заказ ${result.order_id||''} отправлен. Время выдачи подтвердим отдельно.`);
    } catch (err) { error.textContent=err.message||'Не удалось отправить заказ. Попробуй ещё раз.'; }
    finally { button.disabled=cartCount()===0; button.innerHTML='Отправить заказ <span>↗</span>'; }
  }
  async function loadOrders() {
    const node=$('#ordersList'), tg=webApp();
    if(!tg||!tg.initData){node.innerHTML='<div class="empty-cart">История заказов доступна, когда магазин открыт через Telegram.</div>';return;}
    node.innerHTML='<div class="empty-cart">Загружаем историю…</div>';
    try {
      const response=await fetch(API+'/api/my-orders',{headers:{'X-Telegram-Init-Data':tg.initData},cache:'no-store'}); const result=await response.json();
      if(!response.ok)throw new Error(result.detail||'Не удалось загрузить историю.');
      const rows=result.orders||[];
      node.innerHTML=rows.length?rows.map(order=>`<div class="order-row"><div><b>${escapeHtml(order.order_id)}</b><small>${escapeHtml(order.pickup_time||order.created_at||'')} · ${escapeHtml((order.items||[]).map(item=>`${item.name} × ${item.qty}`).join(', '))}</small></div><span class="order-status">${escapeHtml(order.status||'Принят')}</span></div>`).join(''):'<div class="empty-cart">Пока нет заказов.<br>Твои заказы появятся здесь после оформления.</div>';
    } catch(err) { node.innerHTML=`<div class="empty-cart">${escapeHtml(err.message)}</div>`; }
  }
  async function loadInitialData() {
    let fallback={products:[]};
    try { const response=await fetch('./assets/local-catalog-fallback.json',{cache:'force-cache'}); if(response.ok)fallback=await response.json(); } catch { /* server catalog is still usable */ }
    const fallbackMap=new Map((fallback.products||[]).map(p=>[p.id,p]));
    const [menu,categories,content,settings]=await Promise.allSettled([getJson('/api/menu'),getJson('/api/categories'),getJson('/api/site-content'),getJson('/api/store-settings')]);
    if(menu.status==='fulfilled'&&Array.isArray(menu.value)){
      state.products=menu.value.map(remote=>{const local=fallbackMap.get(remote.id)||{};return {...local,...remote,photo:safeImage(remote.photo)||safeImage(local.photo)||'',gallery:Array.isArray(remote.gallery)&&remote.gallery.length?remote.gallery:(local.gallery||[])};}).filter(p=>p.active!==false).sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0));
    } else if(fallback.products?.length){state.products=fallback.products.filter(p=>p.active!==false);toast('Не удалось обновить каталог. Показана сохранённая версия меню.');}
    if(categories.status==='fulfilled')state.categories=categories.value||[];
    if(content.status==='fulfilled')state.sets=content.value.sets||[];
    if(settings.status==='fulfilled')state.settings=settings.value||{};
    state.cart=readStorage('tihiy-v3-cart',{}); state.favorites=new Set(readStorage('tihiy-v3-favorites',[])); state.setCounts=readStorage('tihiy-v3-set-counts',{});
    // Remove unavailable IDs and reconcile saved quantities with live stock.
    for(const id of Object.keys(state.cart)){const product=productById(id);if(!product){delete state.cart[id];continue;}const stock=stockLeft(product);if(stock!==null){if(stock===0)delete state.cart[id];else state.cart[id]=Math.min(Number(state.cart[id])||0,stock,99);}}
    for(const id of [...state.favorites])if(!productById(id))state.favorites.delete(id);
    const slide=(content.status==='fulfilled'?(content.value.slides||[]).find(x=>x.active!==false&&safeImage(x.image)):null);
    const heroPhoto=safeImage(slide?.image)||productImage(state.products[0]); if(heroPhoto)$('#heroPhoto').src=heroPhoto;
    if(slide?.title||slide?.accent){$('#heroTitle').innerHTML=`${escapeHtml(slide?.title||'Тихо готовим,')}<br><em>${escapeHtml(slide?.accent||'громко вкусно')}</em>`;}
    if(slide?.desc)$('#heroSubtitle').textContent=slide.desc;
    if(slide?.button)$('#heroButton').innerHTML=`${escapeHtml(slide.button)} <span>↗</span>`;
    const phone=state.settings.phone||'+7 923 000-58-57'; const phoneDigits=phone.replace(/\D/g,'');
    $('#headerPhone').href=`tel:+${phoneDigits}`; $('#headerPhone b').textContent=phone.replace(/^\+7\s*/, '8 ');
    $('#footerPhone').href=`tel:+${phoneDigits}`; $('#footerPhone').textContent=phone.replace(/^\+7\s*/, '8 ');
    $('#pickupAddress').textContent=state.settings.pickup_address||'Адрес уточним при подтверждении заказа';
    if(state.settings.pickup_map_url)$('#mapLink').href=state.settings.pickup_map_url;else $('#mapLink').hidden=true;
    $('#pickupDescription').textContent=state.settings.description||'Выбирай блюда заранее — приготовим к согласованному времени.';
    $('#footerYear').textContent=String(new Date().getFullYear());
    renderAll(); updateOpenStatus();
    const tg=webApp(); if(tg){tg.ready();tg.expand();}
    if(tg?.initData){fetch(API+'/api/admin/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:tg.initData}),cache:'no-store'}).then(r=>r.json()).then(r=>{if(r.is_admin)$('#adminLink').hidden=false;}).catch(()=>{});}
  }
  function updateOpenStatus() {
    const now=new Date(), hours=hoursFor(now), status=$('#openStatus');
    if(hours.closed||!hours.open||!hours.close){status.classList.add('closed');$('span',status).textContent='Сегодня выходной';}
    else $('span',status).textContent=`Заказы · ${hours.open}–${hours.close}`;
  }

  document.addEventListener('click',event=>{
    const target=event.target.closest('button,a'); if(!target)return;
    if(target.matches('[data-qty]')){adjustProduct(target.dataset.id,Number(target.dataset.qty));return;}
    if(target.matches('[data-cart-qty]')){adjustProduct(target.dataset.id,Number(target.dataset.cartQty));renderCart();return;}
    if(target.matches('[data-favorite]')){const id=target.dataset.favorite;state.favorites.has(id)?state.favorites.delete(id):state.favorites.add(id);saveStorage();renderAll();return;}
    if(target.matches('[data-details]')){showProduct(target.dataset.details);return;}
    if(target.matches('[data-category]')){state.filter=target.dataset.category;renderFilters();renderProducts();$('#menu').scrollIntoView({behavior:'smooth'});return;}
    if(target.matches('[data-filter]')){state.filter=target.dataset.filter;renderFilters();renderProducts();return;}
    if(target.matches('[data-add-set]')){addSet(state.sets.find(s=>s.id===target.dataset.addSet));return;}
    if(target.matches('[data-set-details]')){const set=state.sets.find(s=>s.id===target.dataset.setDetails);if(set)toast('В составе: '+setCompositionText(set));return;}
    if(target.matches('[data-builder-qty]')){const id=target.dataset.id,product=productById(id);if(!product)return;const next=Math.max(0,Number(state.builder[id]||0)+Number(target.dataset.builderQty));const stock=stockLeft(product);if(stock!==null&&next>stock){toast(`В наличии осталось: ${stock} шт.`);return;}if(next)state.builder[id]=next;else delete state.builder[id];renderBuilder();return;}
    if(target.matches('[data-open-cart]')){openModal('cartModal');return;}
    if(target.matches('[data-open-favorites]')){openModal('favoritesModal');return;}
    if(target.matches('[data-open-orders]')){openModal('ordersModal');return;}
    if(target.matches('[data-close-modal]')){closeModal(target.dataset.closeModal);return;}
    if(target.id==='modalAddButton'&&state.currentProduct){adjustProduct(state.currentProduct.id,1);closeModal('productModal');return;}
    if(target.id==='galleryPrev'){moveGallery(-1);return;}
    if(target.id==='galleryNext'){moveGallery(1);return;}
    if(target.id==='addCustomSet'){
      const rows=Object.entries(state.builder).filter(([,qty])=>qty>0);
      if(!rows.length){toast('Выбери хотя бы одно блюдо.');return;}
      for(const [id,qty] of rows){const product=productById(id),stock=stockLeft(product);if(stock!==null&&qtyOf(id)+qty>stock){toast(`Недостаточно товара «${product.name}».`);return;}}
      rows.forEach(([id,qty])=>state.cart[id]=qtyOf(id)+qty);state.setCounts={};state.builder={};saveStorage();renderAll();toast('Твой сет добавлен в корзину.');
    }
  });
  $$('.modal-layer').forEach(layer=>layer.addEventListener('click',event=>{if(event.target===layer)closeModal(layer.id);}));
  document.addEventListener('keydown',event=>{if(event.key==='Escape')$$('.modal-layer.show').forEach(node=>closeModal(node.id));if(event.key==='ArrowLeft'&&$('#productModal').classList.contains('show'))moveGallery(-1);if(event.key==='ArrowRight'&&$('#productModal').classList.contains('show'))moveGallery(1);});
  $('#menuSearch').addEventListener('input',event=>{state.search=event.target.value.trim().toLocaleLowerCase('ru');renderProducts();});
  $('#menuSort').addEventListener('change',event=>{state.sort=event.target.value;renderProducts();});
  $('#fulfillment').addEventListener('change',updateFulfillmentUI);
  $('#pickupDate').addEventListener('change',updatePickupTimes);
  $('#checkoutForm').addEventListener('submit',submitOrder);
  let touchX=0;$('#modalProductPhoto').addEventListener('touchstart',event=>{touchX=event.changedTouches[0]?.clientX||0;},{passive:true});$('#modalProductPhoto').addEventListener('touchend',event=>{const dx=(event.changedTouches[0]?.clientX||0)-touchX;if(Math.abs(dx)>40)moveGallery(dx<0?1:-1);},{passive:true});
  loadInitialData().catch(error=>{console.error(error);$('#productGrid').innerHTML='<div class="loading-card">Не удалось загрузить меню. Обнови страницу позже.</div>';toast('Не удалось подключиться к серверу меню.');});
})();
