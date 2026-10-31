(function(){
  const API='https://tihiy-roll-order-api.onrender.com';
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
  const store=window.__TIHIY_STORE;
  if(!store)return;
  const money=store.money;
  let currentSettings=null;
  let searchValue='';
  let sortValue='popular';

  function createCategorySection(){
    if($('#homeCategories'))return;
    const section=document.createElement('section');
    section.id='homeCategories';section.className='section home-categories';
    section.innerHTML='<div class="section-heading"><h2>Категории</h2><span class="section-note">Выбери, что хочется сегодня</span></div><div class="home-category-grid" id="homeCategoryGrid"></div>';
    const phone=$('.phone-banner');
    const guide=$('#how-to-order');
    if(phone&&guide)phone.after(section);else if(guide)guide.before(section);
    const popular=document.createElement('section');
    popular.id='homePopular';popular.className='section home-popular';
    popular.innerHTML='<div class="section-heading"><h2>Популярное</h2><a href="#menu-section" class="section-note">Смотреть всё →</a></div><div class="home-popular-grid" id="homePopularGrid"></div>';
    section.after(popular);
    const categories=[
      {id:'rolls',label:'Роллы',hint:'Классические и авторские',filter:'all',emoji:'🍣',pick:p=>['classic','warm'].includes(p.cat)},
      {id:'sets',label:'Сеты',hint:'Готовые сочетания',target:'#sets-section',emoji:'🎁'},
      {id:'dogs',label:'Азиатские хот-доги',hint:'Яркий вкус в новом формате',filter:'dogs',emoji:'🌭',pick:p=>p.cat==='dogs'},
      {id:'snacks',label:'Закуски',hint:'Дополнения к заказу',filter:'snacks',emoji:'🍤',pick:p=>p.cat==='snacks'}
    ];
    const root=$('#homeCategoryGrid');
    categories.forEach(category=>{
      const button=document.createElement('button');button.type='button';button.className='home-category-card';
      const product=category.pick?store.products.find(category.pick):null;
      let image=product&&product.photo;
      if(category.id==='sets')image=$('[data-set-image="party"]')?.src||image;
      if(!image)image=store.products[0]?.photo||'';
      const img=document.createElement('img');img.src=image;img.alt='';img.loading='lazy';
      const icon=document.createElement('span');icon.className='home-category-icon';icon.textContent=category.emoji;
      const copy=document.createElement('span');copy.className='home-category-copy';
      const title=document.createElement('b');title.textContent=category.label;
      const hint=document.createElement('small');hint.textContent=category.hint;
      copy.append(title,hint);button.append(img,icon,copy);
      button.addEventListener('click',()=>{
        if(category.target){document.querySelector(category.target)?.scrollIntoView({behavior:'smooth',block:'start'});return;}
        store.renderMenu(category.filter||'all');
        $('#menu-section')?.scrollIntoView({behavior:'smooth',block:'start'});
      });
      root.append(button);
    });
    fetch(API+'/api/categories',{cache:'no-store'}).then(response=>response.ok?response.json():[]).then(rows=>{
      if(!Array.isArray(rows))return;
      const byId=new Map(rows.map(row=>[row.id,row]));
      const mappings=[
        {cardId:'rolls',ids:['classic','warm']},
        {cardId:'sets',ids:['sets']},
        {cardId:'dogs',ids:['dogs']},
        {cardId:'snacks',ids:['snacks']}
      ];
      mappings.forEach(mapping=>{
        const button=root.querySelector('.home-category-card:nth-child('+(
          categories.findIndex(row=>row.id===mapping.cardId)+1
        )+')');
        if(!button)return;
        const source=mapping.ids.map(id=>byId.get(id)).find(Boolean);
        if(!source)return;
        const icon=button.querySelector('.home-category-icon');
        if(icon&&source.icon)icon.textContent=source.icon;
        if(source.image){const img=button.querySelector('img');if(img)img.src=source.image}
        if(mapping.cardId!=='rolls'&&source.name){const title=button.querySelector('.home-category-copy b');if(title)title.textContent=source.name}
      });
      const known=new Set(['classic','warm','all','sets','dogs','snacks']);
      rows.filter(row=>row&&row.id&&!known.has(row.id)).forEach(row=>{
        const button=document.createElement('button');button.type='button';button.className='home-category-card';
        const product=store.products.find(item=>item.cat===row.id);
        const img=document.createElement('img');img.src=row.image||product?.photo||store.products[0]?.photo||'';img.alt='';img.loading='lazy';
        const icon=document.createElement('span');icon.className='home-category-icon';icon.textContent=row.icon||'🍣';
        const copy=document.createElement('span');copy.className='home-category-copy';
        const title=document.createElement('b');title.textContent=row.name;
        const hint=document.createElement('small');hint.textContent=store.products.filter(item=>item.cat===row.id).length+' товаров';
        copy.append(title,hint);button.append(img,icon,copy);
        button.addEventListener('click',()=>{store.renderMenu(row.id);$('#menu-section')?.scrollIntoView({behavior:'smooth',block:'start'})});
        root.append(button);
      });
    }).catch(()=>{});
  }

  function buildCatalogTools(){
    const section=$('#menu-section');
    if(!section||$('.catalog-tools',section))return;
    const tools=document.createElement('div');tools.className='catalog-tools';
    const search=document.createElement('label');search.className='catalog-search';
    search.innerHTML='<input type="search" id="catalogSearch" placeholder="Найти любимый ролл…" autocomplete="off" aria-label="Поиск по меню">';
    const sort=document.createElement('select');sort.id='catalogSort';sort.setAttribute('aria-label','Сортировка товаров');
    [['popular','Сначала популярные'],['price-asc','Сначала дешевле'],['price-desc','Сначала дороже'],['name','По названию']].forEach(([value,label])=>{
      const option=document.createElement('option');option.value=value;option.textContent=label;sort.append(option);
    });
    tools.append(search,sort);
    const filters=$('#categoryFilters',section);
    if(filters)filters.before(tools);else section.append(tools);
    search.querySelector('input').addEventListener('input',event=>{searchValue=event.target.value.trim().toLocaleLowerCase('ru');applyCatalogTools()});
    sort.addEventListener('change',event=>{sortValue=event.target.value;applyCatalogTools()});
  }
  function applyCatalogTools(){
    const root=$('#menu');if(!root)return;
    const products=new Map(store.products.map(product=>[product.id,product]));
    const cards=$$('.card',root);
    cards.forEach(card=>{
      const id=$('[data-details]',card)?.dataset.details;
      const product=products.get(id);
      const text=((product?.name||'')+' '+(product?.desc||'')+' '+(product?.details||'')).toLocaleLowerCase('ru');
      card.hidden=!!searchValue&&!text.includes(searchValue);
    });
    const visible=cards.filter(card=>!card.hidden);
    visible.sort((a,b)=>{
      const pa=products.get($('[data-details]',a)?.dataset.details);
      const pb=products.get($('[data-details]',b)?.dataset.details);
      if(!pa||!pb)return 0;
      if(sortValue==='price-asc')return Number(pa.price)-Number(pb.price);
      if(sortValue==='price-desc')return Number(pb.price)-Number(pa.price);
      if(sortValue==='name')return String(pa.name).localeCompare(String(pb.name),'ru');
      return Number(pa.sort_order||0)-Number(pb.sort_order||0);
    });
    visible.forEach(card=>root.append(card));
    renderPopular();
  }
  function renderPopular(){
    const root=$('#homePopularGrid'),menu=$('#menu');
    if(!root||!menu)return;
    const source=$$('.card',menu).filter(card=>!card.hidden);
    const featured=source.filter(card=>card.querySelector('.product-badge')?.textContent.includes('ХИТ'));
    const selected=[...featured,...source.filter(card=>!featured.includes(card))].slice(0,4);
    root.replaceChildren();
    selected.forEach(card=>{
      const clone=card.cloneNode(true);
      clone.classList.add('featured-card');
      root.append(clone);
    });
    if(!selected.length){
      const note=document.createElement('p');note.className='muted';note.textContent='Популярные позиции появятся после загрузки меню.';root.append(note);
    }
  }

  function enhanceProductDetail(){
    const dialog=$('.product-dialog');
    if(!dialog||$('.product-detail-meta',dialog))return;
    const meta=document.createElement('div');meta.className='product-detail-meta';meta.id='productDetailMeta';
    const ingredients=document.createElement('section');ingredients.className='product-ingredients';
    ingredients.innerHTML='<h3>Состав</h3><div class="product-ingredient-list" id="productIngredientList"></div>';
    const actions=document.createElement('div');actions.className='detail-actions';
    const favorite=document.createElement('button');favorite.type='button';favorite.className='detail-favorite';favorite.id='detailFavorite';favorite.setAttribute('aria-label','Добавить в избранное');favorite.textContent='♡';
    const add=$('#detailAdd',dialog);
    if(add){add.textContent='Добавить в корзину';add.parentNode.insertBefore(actions,add);actions.append(add,favorite);}
    const title=$('#detailTitle',dialog);
    title?.after(meta,ingredients);
    favorite.addEventListener('click',()=>{
      const id=dialog.dataset.productId;if(!id)return;
      if(store.favorites.has(id))store.favorites.delete(id);else store.favorites.add(id);
      store.saveFavorites?.();
      store.renderMenu(store.activeFilter);
      updateDetailFavorite();
    });
    document.addEventListener('click',event=>{
      const card=event.target.closest('#menu .card .food-photo,#menu .card h3,#homePopularGrid .card .food-photo,#homePopularGrid .card h3');
      if(!card||event.target.closest('button'))return;
      const productCard=card.closest('.card');
      const id=$('[data-details]',productCard)?.dataset.details;
      if(id)store.openProductDetails(id);
    });
    function updateDetailFavorite(){
      const id=dialog.dataset.productId;if(!id)return;
      const active=store.favorites.has(id);
      favorite.classList.toggle('active',active);favorite.textContent=active?'♥':'♡';
      favorite.setAttribute('aria-label',active?'Убрать из избранного':'Добавить в избранное');
    }
    const modalObserver=new MutationObserver(()=>{
      if(!dialog.classList.contains('show'))return;
      const title=$('#detailTitle',dialog)?.textContent||'';
      const product=store.products.find(item=>item.name===title);
      if(product)window.__TIHIY_UPDATE_DETAIL(product);
    });
    modalObserver.observe(dialog,{attributes:true,attributeFilter:['class']});
    window.__TIHIY_UPDATE_DETAIL=product=>{
      if(!product)return;
      dialog.dataset.productId=product.id;
      meta.replaceChildren();
      [[product.weight||'Вес уточняется','⚖'],[(product.pieces||8)+' шт.','▣'],[money(product.price),'₽']].forEach(([value,icon])=>{
        const chip=document.createElement('span');chip.textContent=icon+' '+value;meta.append(chip);
      });
      const list=$('#productIngredientList');list.replaceChildren();
      const raw=String(product.details||product.desc||'').replace(/^Состав:\s*/i,'');
      const parsed=raw.split(/[,;.\n]+/).map(item=>item.trim()).filter(Boolean).slice(0,8);
      (parsed.length?parsed:['Состав уточняется']).forEach(item=>{
        const chip=document.createElement('span');chip.className='ingredient-chip';chip.textContent=item;list.append(chip);
      });
      updateDetailFavorite();
      if(add)add.textContent='Добавить в корзину · '+money(product.price);
    };
  }

  function enhanceCart(){
    const sheet=$('.sheet');
    if(!sheet||$('.checkout-steps',sheet))return;
    const steps=document.createElement('div');steps.className='checkout-steps';
    steps.innerHTML='<span class="active"><i>1</i> Корзина</span><span><i>2</i> Получение</span><span><i>3</i> Подтверждение</span>';
    $('.sheet-top',sheet)?.after(steps);
    const delivery=$('#deliveryAddressWrap');
    if(delivery&&!$('#deliveryNote')){
      const note=document.createElement('p');note.id='deliveryNote';note.className='delivery-note';
      note.textContent='Стоимость доставки подтвердим отдельно после получения заказа.';
      delivery.append(note);
    }
    const form=$('#form',sheet);
    form?.addEventListener('input',()=>{});
    const observer=new MutationObserver(()=>{
      const formVisible=form&&!form.hidden;
      const items=$('#items',sheet);
      const checkout=formVisible;
      steps.querySelectorAll('span').forEach((step,index)=>{
        step.classList.toggle('active',checkout?index===1:index===0);
        step.classList.toggle('done',checkout&&index===0);
      });
      if($('#success',sheet)?.hidden===false){
        steps.querySelectorAll('span').forEach((step,index)=>{step.classList.toggle('active',index===2);step.classList.toggle('done',index<2)});
      }
    });
    observer.observe(sheet,{attributes:true,subtree:true,attributeFilter:['hidden','class']});
  }

  async function loadShopSettings(){
    try{
      const response=await fetch(API+'/api/store-settings',{cache:'no-store'});
      if(!response.ok)return;
      const settings=await response.json();
      currentSettings=settings;window.__TIHIY_STORE_SETTINGS=settings;
      const phoneDigits=String(settings.phone||'').replace(/\D/g,'');
      $$('.phone-banner').forEach(el=>{
        const link=$('a',el)||el;
        if(phoneDigits.length>=10)link.href='tel:+'+phoneDigits;
        const number=$('.phone-number',el);if(number)number.textContent=settings.phone||number.textContent;
      });
      $$('.footer-phone').forEach(el=>{
        const number=$('b',el);if(number)number.textContent=settings.phone||number.textContent;
        if(phoneDigits.length>=10)el.href='tel:+'+phoneDigits;
      });
      if(settings.shop_name){
        $$('.brand-title').forEach(el=>{el.textContent=settings.shop_name.toUpperCase()});
      }
      const address=$('.pickup-address-card p');
      if(address&&settings.pickup_address){
        address.replaceChildren();
        const strong=document.createElement('strong');strong.textContent=settings.shop_name||'Тихий ролл';
        const br=document.createElement('br');const text=document.createTextNode(settings.pickup_address);
        address.append(strong,br,text);
      }
      const map=$('.pickup-map-link');if(map&&settings.pickup_map_url)map.href=settings.pickup_map_url;
      const frame=$('.pickup-map');if(frame&&settings.pickup_map_url){
        const mapText=encodeURIComponent(settings.pickup_address||'Тихий ролл, Чарышское');
        frame.src='https://yandex.ru/map-widget/v1/?text='+mapText;
      }
      const deliveryLabel=$('input[name="fulfillment"][value="Доставка"]')?.closest('label');
      const pickupLabel=$('input[name="fulfillment"][value="Самовывоз"]')?.closest('label');
      if(deliveryLabel)deliveryLabel.hidden=settings.delivery_enabled===false;
      if(pickupLabel)pickupLabel.hidden=settings.pickup_enabled===false;
      if(settings.delivery_enabled===false&&$('input[name="fulfillment"][value="Доставка"]')?.checked&&settings.pickup_enabled!==false){
        $('input[name="fulfillment"][value="Самовывоз"]').checked=true;
        $('input[name="fulfillment"][value="Самовывоз"]').dispatchEvent(new Event('change',{bubbles:true}));
      }
      const note=$('#deliveryNote');if(note)note.textContent=settings.delivery_note||'Стоимость доставки подтвердим отдельно.';
      const minimum=Number(settings.minimum_order||0);
      if(minimum>0){
        const info=document.createElement('p');info.id='minimumOrderInfo';info.className='delivery-note';
        info.textContent='Минимальный заказ для доставки: '+money(minimum)+'.';
        $('#deliveryAddressWrap')?.append(info);
      }
      const dayNames=['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
      function hoursFor(date){
        const idx=date.getDay()===0?6:date.getDay()-1;
        return Array.isArray(settings.weekly_hours)?settings.weekly_hours[idx]:null;
      }
      const pickupSelect=$('#pickupTime');
      if(pickupSelect&&Array.isArray(settings.weekly_hours)){
        const dateChoice=()=>{
          if($('#pickupDay')?.value==='tomorrow'){const d=new Date();d.setDate(d.getDate()+1);return d}
          if($('#pickupDay')?.value==='custom'&&$('#pickupDate')?.value){const [y,m,d]=$('#pickupDate').value.split('-').map(Number);return new Date(y,m-1,d)}
          return new Date();
        };
        function rebuildTimes(){
          const date=dateChoice(),hours=hoursFor(date);
          const previous=pickupSelect.value;
          pickupSelect.replaceChildren();
          const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Выберите время';pickupSelect.append(placeholder);
          if(hours&&!hours.closed&&hours.open&&hours.close){
            const [oh,om]=hours.open.split(':').map(Number),[ch,cm]=hours.close.split(':').map(Number);
            let minute=oh*60+om,end=ch*60+cm;
            for(;minute<=end-30;minute+=30){
              const value=String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
              const option=document.createElement('option');option.value=value;option.textContent=value;pickupSelect.append(option);
            }
          }else{
            const unavailable=document.createElement('option');unavailable.value='';unavailable.textContent=(hours&&hours.closed)?'Выходной день':'Время не настроено';unavailable.disabled=true;pickupSelect.append(unavailable);
          }
          if([...pickupSelect.options].some(option=>option.value===previous))pickupSelect.value=previous;
        }
        $('#pickupDay')?.addEventListener('change',rebuildTimes);
        $('#pickupDate')?.addEventListener('change',rebuildTimes);
        rebuildTimes();
      }
      store.refreshPickupChoices();
      store.updatePickupTimes();
    }catch(error){console.warn('Настройки магазина пока не загружены:',error)}
  }

  function activateNav(){
    const links=$$('.quick-nav a[href^="#"]');
    const sections=links.map(link=>({link,target:$(link.getAttribute('href'))})).filter(row=>row.target);
    if(!('IntersectionObserver' in window))return;
    const observer=new IntersectionObserver(entries=>{
      entries.forEach(entry=>{
        if(!entry.isIntersecting)return;
        sections.forEach(({link,target})=>link.classList.toggle('is-current',target===entry.target));
      });
    },{rootMargin:'-20% 0px -65% 0px'});
    sections.forEach(({target})=>observer.observe(target));
  }

  createCategorySection();
  buildCatalogTools();
  enhanceProductDetail();
  enhanceCart();
  applyCatalogTools();
  renderPopular();
  window.addEventListener('tihiy:catalog-rendered',()=>{applyCatalogTools()});
  loadShopSettings();
  activateNav();
})();