(function(){
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
  const money=value=>new Intl.NumberFormat('ru-RU').format(Number(value)||0)+' ₽';
  const statusNames={new:'Новый',accepted:'Принят',preparing:'Готовится',ready:'Готов к выдаче',completed:'Выдан',cancelled:'Отменён'};
  const statusOrder=['new','accepted','preparing','ready','completed'];
  const statusClass=status=>'status-'+(status||'new');
  let ordersFilter='all',ordersSearch='',ordersFrom='',ordersTo='',ordersMethod='all',selectedOrderId=null,settingsCache=null;
  let settingsLoaded=false,orderStoreSettings=null,orderStoreSettingsPromise=null;

  function page(id,title,subtitle){
    const section=document.createElement('section');section.className='admin-page'+(id==='home'?' active':'');section.dataset.page=id;
    const heading=document.createElement('div');heading.className='admin-page-title';
    const copy=document.createElement('div');const h=document.createElement('h1');h.textContent=title;
    const p=document.createElement('p');p.textContent=subtitle||'Панель владельца · Тихий ролл';
    copy.append(h,p);heading.append(copy);section.append(heading);return section;
  }
  function panel(title,description){
    const el=document.createElement('section');el.className='panel';
    if(title){const h=document.createElement('h2');h.textContent=title;el.append(h)}
    if(description){const p=document.createElement('p');p.className='muted';p.textContent=description;el.append(p)}
    return el;
  }
  function safeText(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
  function safeImage(src){
    return src||'data:image/svg+xml;charset=UTF-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100%" height="100%" fill="#1a252a"/><text x="50%" y="52%" text-anchor="middle" fill="#ff8074" font-size="15">Нет фото</text></svg>');
  }
  function setStatusBadge(status){
    const span=document.createElement('span');span.className='admin-status '+statusClass(status);span.textContent=statusNames[status]||statusNames.new;return span;
  }
  function init(){
    const wrap=$('main.wrap'),app=$('#app');
    if(!wrap||!app||wrap.dataset.fullWorkspace==='1')return;
    wrap.dataset.fullWorkspace='1';
    const head=$('.head',wrap),status=$('#status'),login=$('#login'),foot=$('.foot',wrap);
    const productPanel=$('#list')?.closest('.panel');
    const orderPanel=$('#refreshOrders')?.closest('.panel');
    const categoryPanel=$('#categoriesList')?.closest('.panel');
    const editor=$('#editor');
    const contentPanel=$('#reloadContent')?.closest('.panel');
    if(!head||!productPanel||!orderPanel||!categoryPanel||!contentPanel)return;

    const shell=document.createElement('div');shell.className='admin-shell';
    const sidebar=document.createElement('aside');sidebar.className='admin-sidebar';
    sidebar.innerHTML='<div class="admin-logo"><span>Т</span> ТИХИЙ РОЛЛ<small>АДМИН-ПАНЕЛЬ</small></div><nav class="admin-nav" aria-label="Разделы админ-панели"></nav><div class="admin-sidebar-foot">Панель владельца · данные загружаются с сервера<br><a href="../" target="_blank" rel="noopener">Открыть магазин ↗</a></div>';
    const main=document.createElement('div');main.className='admin-main';
    wrap.insertBefore(shell,head);shell.append(sidebar,main);main.append(head);
    if(status)main.append(status);
    if(login)main.append(login);
    main.append(app);
    const legacyData=document.createElement('div');legacyData.className='hidden';legacyData.id='legacyAdminData';
    legacyData.append(orderPanel);main.append(legacyData);
    if(foot)main.append(foot);

    const home=page('home','Главная','Обзор магазина и быстрый доступ к ежедневным задачам');
    home.innerHTML+='<div class="admin-home-hero"><div><h2>Тихий ролл · магазин под контролем</h2><p>Заказы, меню, фотографии и показатели продаж — в одном рабочем пространстве.</p></div><div class="admin-home-actions"><button class="btn primary" type="button" data-go="orders">Открыть новые заказы</button><button class="btn" type="button" data-go="products">Добавить товар</button></div></div><div class="admin-kpis" id="homeKpis"></div><div class="admin-home-grid"><section class="panel"><div class="toolbar"><div><h2 style="margin:0">Быстрые действия</h2><p class="muted">Основные ежедневные операции</p></div></div><div class="admin-home-shortcuts"><button class="admin-home-shortcut" type="button" data-go="orders"><i>▤</i><span><b>Заказы</b><small>Принять и обновить статус</small></span></button><button class="admin-home-shortcut" type="button" data-go="products"><i>🍣</i><span><b>Товары</b><small>Фото, состав и стоимость</small></span></button><button class="admin-home-shortcut" type="button" data-go="sets"><i>🎁</i><span><b>Готовые сеты</b><small>Состав и галерея</small></span></button><button class="admin-home-shortcut" type="button" data-go="banners"><i>▧</i><span><b>Главная и баннеры</b><small>Слайды и рекламный блок</small></span></button></div></section><section class="panel"><h2>Последние заказы</h2><div id="homeRecentOrders"></div></section></div>';
    const orders=page('orders','Заказы','Новые заявки, приготовление, самовывоз и доставка');
    const ordersPanelNew=panel('Список заказов','Выбери заказ слева — подробная карточка откроется справа.');
    const ordersToolbar=document.createElement('div');ordersToolbar.className='admin-orders-toolbar';
    ordersToolbar.innerHTML='<input id="adminOrderSearch" type="search" placeholder="⌕  Поиск по номеру, имени или телефону"><button class="btn" id="adminRefreshOrders" type="button">↻  Обновить</button>';
    const ordersAdvanced=document.createElement('div');ordersAdvanced.className='admin-orders-advanced';
    ordersAdvanced.innerHTML='<label>С даты<input id="adminOrderFrom" type="date" aria-label="Заказы с даты"></label><label>По дату<input id="adminOrderTo" type="date" aria-label="Заказы по дату"></label><label>Получение<select id="adminOrderMethod"><option value="all">Все способы</option><option value="pickup">Самовывоз</option><option value="delivery">Доставка</option></select></label>';
    const filters=document.createElement('div');filters.className='admin-orders-filters';
    [['all','Все'],['new','Новые'],['accepted','Приняты'],['preparing','Готовим'],['ready','Готовы'],['delivery','Доставка'],['completed','Выданы'],['cancelled','Отменены']].forEach(([value,label])=>{
      const button=document.createElement('button');button.type='button';button.className='admin-filter'+(value==='all'?' active':'');button.dataset.filter=value;button.dataset.label=label;button.textContent=label;filters.append(button);
    });
    const orderLayout=document.createElement('div');orderLayout.className='admin-orders-layout';
    const orderList=document.createElement('div');orderList.className='admin-order-list';orderList.id='fullOrderList';
    const orderDetail=document.createElement('div');orderDetail.className='admin-order-detail';orderDetail.id='fullOrderDetail';
    orderLayout.append(orderList,orderDetail);ordersPanelNew.append(ordersToolbar,ordersAdvanced,filters,orderLayout);orders.append(ordersPanelNew);

    const products=page('products','Товары','Каталог, фотографии, состав, вес, цены и наличие');
    products.append(productPanel);if(editor)products.append(editor);

    const categories=page('categories','Категории','Структура каталога и порядок категорий');
    categories.append(categoryPanel);

    const sets=page('sets','Готовые сеты','Состав наборов, главная фотография и дополнительные кадры');
    const setTitle=[...contentPanel.querySelectorAll('h3')].find(el=>el.textContent.trim()==='Готовые сеты');
    const setDescription=setTitle?.nextElementSibling;
    const setEditor=$('#setEditor',contentPanel);
    const setPanel=panel('Редактор готовых сетов','Настраивай описания и до пяти дополнительных фотографий для каждого набора.');
    if(setTitle)setTitle.remove();if(setDescription)setDescription.remove();if(setEditor)setEditor.remove();
    if(setEditor)setPanel.append(setEditor);
    const saveSet=document.createElement('div');saveSet.className='formactions';
    saveSet.innerHTML='<button class="btn primary" type="button" id="saveSetsFull">Сохранить изменения сетов</button>';
    setPanel.append(saveSet);sets.append(setPanel);

    const banners=page('banners','Главная и баннеры','Первый экран магазина, рекламные блоки и слайды');
    banners.append(contentPanel);
    const contentTabs=document.createElement('div');contentTabs.className='admin-content-tabs';
    [['main','Главная страница'],['slides','Слайды']].forEach(([id,label])=>{
      const button=document.createElement('button');button.type='button';button.className='admin-content-tab'+(id==='main'?' active':'');button.dataset.contentTab=id;button.textContent=label;contentTabs.append(button);
    });
    contentPanel.insertBefore(contentTabs,contentPanel.children[1]||null);
    const contentGrid=contentPanel.querySelector('.formgrid');
    const slidesTitle=[...contentPanel.querySelectorAll('h3')].find(el=>el.textContent.trim()==='Слайды главного экрана');
    const slidesDescription=slidesTitle?.nextElementSibling;
    const slideEditor=$('#slideEditor',contentPanel);
    const saveRow=$('#saveContent',contentPanel)?.closest('.formactions');
    [contentGrid,slidesTitle,slidesDescription,slideEditor,saveRow].forEach(node=>{if(node)node.classList.add('admin-content-subsection')});
    if(contentGrid){contentGrid.dataset.contentPane='main';contentGrid.classList.add('active')}
    [slidesTitle,slidesDescription,slideEditor].forEach(node=>{if(node)node.dataset.contentPane='slides'});
    if(saveRow){saveRow.classList.remove('admin-content-subsection');saveRow.dataset.contentSave='1'}
    contentTabs.addEventListener('click',event=>{
      const button=event.target.closest('[data-content-tab]');if(!button)return;
      const key=button.dataset.contentTab;
      contentTabs.querySelectorAll('.admin-content-tab').forEach(el=>el.classList.toggle('active',el===button));
      contentPanel.querySelectorAll('[data-content-pane]').forEach(el=>el.classList.toggle('active',el.dataset.contentPane===key));
    });

    const analytics=page('analytics','Аналитика продаж','Реальные сводные показатели из заказов магазина');
    const analyticsRoot=document.createElement('div');analyticsRoot.className='admin-analytics-root';analyticsRoot.id='fullAnalyticsRoot';analytics.append(analyticsRoot);
    const settings=page('settings','Настройки магазина','Адрес, график, получение заказов, доставка и подключённые сервисы');
    const settingsRoot=document.createElement('div');settingsRoot.id='fullSettingsRoot';settings.append(settingsRoot);

    app.replaceChildren(home,orders,products,categories,sets,banners,analytics,settings);
    const nav=$('.admin-nav',sidebar);
    const navItems=[
      ['home','⌂','Главная'],['orders','▤','Заказы'],['products','▦','Товары'],
      ['sets','🎁','Сеты'],['categories','☷','Категории'],['banners','▧','Баннеры'],
      ['analytics','▥','Аналитика'],['settings','⚙','Настройки']
    ];
    function activate(id){
      app.querySelectorAll('.admin-page').forEach(el=>el.classList.toggle('active',el.dataset.page===id));
      nav.querySelectorAll('button').forEach(el=>el.classList.toggle('active',el.dataset.go===id));
      try{sessionStorage.setItem('tihiy-admin-page',id)}catch(_){}
      if(id==='orders')renderOrders();
      if(id==='analytics')renderAnalytics();
      if(id==='settings'&&!settingsLoaded)loadSettings();
      window.scrollTo({top:0,behavior:'smooth'});
    }
    navItems.forEach(([id,icon,label])=>{
      const button=document.createElement('button');button.type='button';button.dataset.go=id;
      const i=document.createElement('span');i.className='nav-icon';i.textContent=icon;
      const t=document.createElement('span');t.textContent=label;button.append(i,t);
      if(id==='orders'){const count=document.createElement('b');count.className='admin-nav-count';count.id='adminNavOrderCount';count.textContent='0';button.append(count)}
      button.addEventListener('click',()=>activate(id));nav.append(button);
    });
    app.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>activate(button.dataset.go)));
    $('#saveSetsFull')?.addEventListener('click',()=>$('#saveContent')?.click());
    $('#adminRefreshOrders')?.addEventListener('click',()=>window.TihiyAdmin?.reloadOrders());
    $('#adminOrderSearch')?.addEventListener('input',event=>{ordersSearch=event.target.value.trim().toLocaleLowerCase('ru');renderOrders()});
    $('#adminOrderFrom')?.addEventListener('change',event=>{ordersFrom=event.target.value;renderOrders()});
    $('#adminOrderTo')?.addEventListener('change',event=>{ordersTo=event.target.value;renderOrders()});
    $('#adminOrderMethod')?.addEventListener('change',event=>{ordersMethod=event.target.value;renderOrders()});
    filters.addEventListener('click',event=>{
      const button=event.target.closest('[data-filter]');if(!button)return;
      ordersFilter=button.dataset.filter;
      filters.querySelectorAll('[data-filter]').forEach(el=>el.classList.toggle('active',el===button));
      renderOrders();
    });
    window.addEventListener('tihiy:orders-updated',()=>{renderOrders();renderHome()});
    window.addEventListener('tihiy:analytics-updated',()=>{renderAnalytics();renderHome()});
    window.addEventListener('tihiy:store-settings-saved',()=>{settingsLoaded=false;if(settings.dataset.page==='settings')loadSettings()});
    const preferred=(()=>{try{return sessionStorage.getItem('tihiy-admin-page')}catch(_){return null}})();
    activate(navItems.some(item=>item[0]===preferred)?preferred:'home');
    renderOrders();renderHome();renderAnalytics();

    function renderHome(){
      const report=window.__TIHIY_ADMIN_REPORT__?.summary||{};
      const rows=window.TihiyAdmin?.getOrders?.()||[];
      const productCount=window.TihiyAdmin?.getProducts?.().length||0;
      const valid=Number(report.valid_orders_count||0);
      const kpis=[
        ['Выручка',money(report.revenue||0),'Без отменённых заказов'],
        ['Заказы',String(report.orders_count||0),'Всего сохранено'],
        ['Средний чек',money(report.average_check||0),valid+' заказов в расчёте'],
        ['Активные',String(report.active_orders||0),'В работе сейчас']
      ];
      const root=$('#homeKpis');if(root){root.replaceChildren();kpis.forEach(([label,value,note])=>{const card=document.createElement('div');card.className='admin-kpi';const s=document.createElement('span');s.textContent=label;const v=document.createElement('strong');v.textContent=value;const n=document.createElement('small');n.textContent=note;card.append(s,v,n);root.append(card)})}
      const recent=$('#homeRecentOrders');if(recent){
        recent.replaceChildren();
        if(!rows.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Новых заказов пока нет.';recent.append(empty)}
        rows.slice(0,5).forEach(order=>{
          const row=document.createElement('div');row.className='admin-home-recent';
          const left=document.createElement('div');const id=document.createElement('b');id.textContent='#'+order.order_id;const name=document.createElement('small');name.textContent=(order.customer_name||'Клиент')+' · '+(order.items||[]).length+' поз.';left.append(id,name);
          const right=document.createElement('div');const amount=document.createElement('b');amount.textContent=money(order.total);right.append(amount,setStatusBadge(order.status));
          row.append(left,right);row.addEventListener('click',()=>activate('orders'));recent.append(row);
        });
      }
      const homeTitle=$('.admin-home-hero p',home);if(homeTitle)homeTitle.textContent='Меню: '+productCount+' товаров · Заказов в последней загрузке: '+rows.length+'.';
    }

    function parseNotes(notes){
      const text=String(notes||'').replace(/\\n/g,'\n');
      const fulfillment=(text.match(/Способ получения:\s*([^\n]+)/i)||[])[1]||'Не указан';
      const address=(text.match(/Адрес доставки:\s*([^\n]+)/i)||[])[1]||'';
      const remainder=text.split(/\r?\n|\\n/).filter(line=>!/^Способ получения:/i.test(line)&&!/^Адрес доставки:/i.test(line)).join('\n').trim();
      return {fulfillment,address,remainder};
    }
    function orderDate(order){
      const value=String(order.created_at||'');
      const date=new Date(value);
      return Number.isNaN(date.getTime())?value:date.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    }
    function orderMethod(order){
      return parseNotes(order.notes).fulfillment;
    }
    function matchesOrderFilter(order,key){
      if(key==='delivery')return /достав/i.test(orderMethod(order));
      if(key==='pickup')return /самовывоз/i.test(orderMethod(order));
      if(key!=='all')return order.status===key;
      return true;
    }
    function orderCount(rows,key){return rows.filter(order=>matchesOrderFilter(order,key)).length}
    function orderInDateRange(order){
      if(!ordersFrom&&!ordersTo)return true;
      const date=new Date(order.created_at||'');
      if(Number.isNaN(date.getTime()))return false;
      const day=date.toISOString().slice(0,10);
      return (!ordersFrom||day>=ordersFrom)&&(!ordersTo||day<=ordersTo);
    }
    function renderOrders(){
      const rows=window.TihiyAdmin?.getOrders?.()||window.__TIHIY_ADMIN_ORDERS||[];
      const filtered=rows.filter(order=>{
        if(!matchesOrderFilter(order,ordersFilter))return false;
        if(ordersMethod==='delivery'&&!/достав/i.test(orderMethod(order)))return false;
        if(ordersMethod==='pickup'&&!/самовывоз/i.test(orderMethod(order)))return false;
        if(!orderInDateRange(order))return false;
        if(!ordersSearch)return true;
        const hay=[order.order_id,order.customer_name,order.phone,order.pickup_time,order.notes].join(' ').toLocaleLowerCase('ru');
        return hay.includes(ordersSearch);
      });
      if(!filtered.some(order=>order.order_id===selectedOrderId))selectedOrderId=filtered[0]?.order_id||null;
      filters.querySelectorAll('[data-filter]').forEach(button=>{
        const key=button.dataset.filter;
        const count=orderCount(rows,key);
        button.classList.toggle('active',key===ordersFilter);
        button.replaceChildren(document.createTextNode(button.dataset.label||key));
        const badge=document.createElement('b');badge.textContent=String(count);button.append(badge);
      });
      const pending=rows.filter(order=>['new','accepted','preparing'].includes(order.status)).length;
      const navCount=$('#adminNavOrderCount');if(navCount)navCount.textContent=String(pending);
      orderList.replaceChildren();
      if(!filtered.length){
        const empty=document.createElement('div');empty.className='admin-empty';
        empty.textContent=rows.length?'По этому фильтру заказов нет.':'Заказов пока нет. Новые заявки появятся здесь после оформления.';
        orderList.append(empty);
      }
      filtered.forEach(order=>{
        const row=document.createElement('button');row.type='button';
        row.className='admin-order-row'+(order.order_id===selectedOrderId?' active':'');
        const primary=document.createElement('span');primary.className='admin-order-primary';
        const thumb=document.createElement('img');thumb.className='admin-order-thumb';
        const first=order.items?.[0];
        const product=window.TihiyAdmin?.getProducts?.().find(item=>item.id===first?.id);
        thumb.src=safeImage(product?.photo||first?.photo||'');thumb.alt='';
        const meta=document.createElement('span');meta.className='admin-order-meta';
        const id=document.createElement('b');id.textContent='#'+order.order_id;
        const customer=document.createElement('strong');customer.textContent=order.customer_name||'Клиент';
        const details=document.createElement('small');details.textContent=orderDate(order)+' · '+(order.items||[]).length+' поз.';
        const method=document.createElement('small');method.className='admin-order-method';method.textContent=orderMethod(order);
        meta.append(id,customer,details,method);primary.append(thumb,meta);
        const aside=document.createElement('span');aside.className='admin-order-row-aside';
        const amount=document.createElement('b');amount.className='admin-order-price';amount.textContent=money(order.total);
        const status=setStatusBadge(order.status);aside.append(amount,status);
        row.append(primary,aside);
        row.addEventListener('click',()=>{selectedOrderId=order.order_id;renderOrders()});
        orderList.append(row);
      });
      const selected=rows.find(order=>order.order_id===selectedOrderId);
      renderOrderDetail(selected);
    }
    function loadOrderStoreSettings(){
      if(orderStoreSettings)return Promise.resolve(orderStoreSettings);
      if(!orderStoreSettingsPromise){
        orderStoreSettingsPromise=window.TihiyAdmin.api('/api/admin/store-settings')
          .then(result=>(orderStoreSettings=result||{}))
          .catch(()=>{orderStoreSettings={settings:{pickup_address:'с. Чарышское, Алтайский край'},integrations:{}};return orderStoreSettings});
      }
      return orderStoreSettingsPromise;
    }
    function makeOrderCard(title,contentClass){
      const card=document.createElement('section');card.className='admin-order-side-card '+(contentClass||'');
      const heading=document.createElement('h3');heading.textContent=title;card.append(heading);return card;
    }
    function renderOrderDetail(order){
      orderDetail.replaceChildren();
      if(!order){
        const empty=document.createElement('div');empty.className='admin-empty admin-order-empty';
        empty.textContent='Выбери заказ из списка, чтобы увидеть состав, клиента и управлять статусом.';
        orderDetail.append(empty);return;
      }
      const notes=parseNotes(order.notes);
      const detailHeader=document.createElement('header');detailHeader.className='admin-order-detail-head';
      const heading=document.createElement('div');heading.className='admin-order-detail-title';
      const titleLine=document.createElement('div');titleLine.className='admin-order-title-line';
      const h=document.createElement('h2');h.textContent='Заказ #'+order.order_id;
      const copyId=document.createElement('button');copyId.type='button';copyId.className='admin-icon-btn';copyId.title='Скопировать номер';copyId.textContent='▢';
      copyId.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(String(order.order_id));copyId.textContent='✓'}catch(_){copyId.textContent=String(order.order_id)}});
      titleLine.append(h,copyId);
      const date=document.createElement('p');date.textContent='Создан '+orderDate(order);
      heading.append(titleLine,date);
      const controls=document.createElement('div');controls.className='admin-order-head-actions';
      const print=document.createElement('button');print.type='button';print.className='btn';print.textContent='▣  Печать чека';print.addEventListener('click',()=>window.print());
      const message=document.createElement('a');message.className='btn';message.textContent='▤  Написать клиенту';
      const phoneDigits=String(order.phone||'').replace(/\D/g,'');
      message.href=phoneDigits?'https://wa.me/'+phoneDigits:'#';message.target='_blank';message.rel='noopener';
      if(!phoneDigits){message.classList.add('disabled');message.setAttribute('aria-disabled','true')}
      const more=document.createElement('details');more.className='admin-order-more';
      more.innerHTML='<summary aria-label="Дополнительные действия">•••</summary><div class="admin-order-more-menu"><button type="button" data-copy-phone>Скопировать телефон</button><button type="button" data-copy-order>Скопировать номер заказа</button></div>';
      more.querySelector('[data-copy-phone]').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(String(order.phone||''));more.open=false;status('Телефон скопирован','ok')}catch(_){status('Не удалось скопировать телефон','error')}});
      more.querySelector('[data-copy-order]').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(String(order.order_id));more.open=false;status('Номер заказа скопирован','ok')}catch(_){status('Не удалось скопировать номер','error')}});
      controls.append(print,message,more);detailHeader.append(heading,controls);orderDetail.append(detailHeader);

      const flow=[['accepted','Принят'],['preparing','Готовим'],['ready','Готов к выдаче'],['completed','Выдан']];
      const current=flow.findIndex(step=>step[0]===order.status);
      const progress=document.createElement('div');progress.className='admin-order-progress';
      flow.forEach(([key,label],index)=>{
        const step=document.createElement('div');step.className='admin-order-step'+(index<current?' done':'')+(index===current?' current':'');
        const mark=document.createElement('i');mark.textContent=index<current?'✓':String(index+1);
        const caption=document.createElement('span');caption.textContent=label;step.append(mark,caption);progress.append(step);
      });
      const columns=document.createElement('div');columns.className='admin-order-detail-columns';
      const mainColumn=document.createElement('div');mainColumn.className='admin-order-main-column';
      const itemsCard=document.createElement('section');itemsCard.className='admin-order-content-card';
      const itemsHeading=document.createElement('div');itemsHeading.className='admin-order-content-heading';
      const itemsTitle=document.createElement('h3');itemsTitle.textContent='Состав заказа';
      const itemCount=document.createElement('span');itemCount.textContent=(order.items||[]).length+' позиций';
      itemsHeading.append(itemsTitle,itemCount);itemsCard.append(itemsHeading);
      const items=document.createElement('div');items.className='admin-order-items';
      (order.items||[]).forEach(item=>{
        const row=document.createElement('div');row.className='admin-order-item';
        const product=window.TihiyAdmin?.getProducts?.().find(entry=>entry.id===item.id);
        const image=document.createElement('img');image.src=safeImage(product?.photo||item.photo||'');image.alt='';
        const label=document.createElement('div');label.className='admin-order-item-copy';
        const name=document.createElement('b');name.textContent=item.name||product?.name||item.id;
        const unitPrice=Number(item.price??product?.price??0),quantity=Number(item.qty)||0;
        const amount=document.createElement('small');amount.textContent=(product?.pieces||item.pieces||8)+' шт. · '+(product?.weight||item.weight||'')+' · × '+quantity;
        label.append(name,amount);
        const sum=document.createElement('strong');sum.textContent=money(item.subtotal??(quantity*unitPrice));
        row.append(image,label,sum);items.append(row);
      });
      itemsCard.append(items);
      const summary=document.createElement('div');summary.className='admin-order-summary';
      const itemsTotal=document.createElement('div');itemsTotal.innerHTML='<span>Товары</span><b>'+money(order.total)+'</b>';
      const deliveryTotal=document.createElement('div');deliveryTotal.innerHTML='<span>Доставка</span><b>'+( /достав/i.test(notes.fulfillment)?'Уточняется':'Самовывоз')+'</b>';
      const total=document.createElement('div');total.className='grand-total';total.innerHTML='<span>Итого к оплате</span><strong>'+money(order.total)+'</strong>';
      summary.append(itemsTotal,deliveryTotal,total);itemsCard.append(summary);
      mainColumn.append(itemsCard);

      const payment=document.createElement('section');payment.className='admin-order-content-card admin-payment-card';
      payment.innerHTML='<div><h3>Оплата</h3><p>При получении</p></div><div><h3>Онлайн-оплата</h3><p class="payment-unconfirmed">Не подключена</p></div>';
      mainColumn.append(payment);
      const actionCard=document.createElement('section');actionCard.className='admin-order-content-card admin-status-action-card';
      const statusHeading=document.createElement('div');statusHeading.className='admin-order-content-heading';
      const statusLabel=document.createElement('h3');statusLabel.textContent='Управление заказом';statusHeading.append(statusLabel);
      const statusSelect=document.createElement('select');statusSelect.className='admin-order-status-select';
      [['new','Новый'],['accepted','Принят'],['preparing','Готовим'],['ready','Готов к выдаче'],['completed','Выдан'],['cancelled','Отменён']].forEach(([key,label])=>{
        const option=document.createElement('option');option.value=key;option.textContent=label;option.selected=key===order.status;statusSelect.append(option);
      });
      statusSelect.addEventListener('change',async()=>{
        const next=statusSelect.value;if(next===order.status)return;
        if(next==='cancelled'&&!confirm('Отменить заказ #'+order.order_id+'?')){statusSelect.value=order.status;return}
        statusSelect.disabled=true;
        try{
          await window.TihiyAdmin.api('/api/admin/orders/'+encodeURIComponent(order.order_id),{method:'PATCH',body:JSON.stringify({status:next})});
          await window.TihiyAdmin.reloadOrders();
          status('Статус заказа обновлён'+(next!=='cancelled'?' · клиенту отправлено уведомление при доступности Telegram':'') ,'ok');
        }catch(error){status(error.message,'error');statusSelect.value=order.status;statusSelect.disabled=false}
      });
      statusHeading.append(statusSelect);
      const quickActions=document.createElement('div');quickActions.className='admin-order-actions';
      const nextStatus=({new:'accepted',accepted:'preparing',preparing:'ready',ready:'completed'})[order.status];
      const nextLabel=({new:'Принять заказ',accepted:'Начать готовить',preparing:'Готов к выдаче',ready:'Отметить выданным'})[order.status];
      if(nextStatus){
        const nextButton=document.createElement('button');nextButton.type='button';nextButton.className='btn primary';nextButton.textContent=nextLabel;
        nextButton.addEventListener('click',async()=>{
          nextButton.disabled=true;
          try{await window.TihiyAdmin.api('/api/admin/orders/'+encodeURIComponent(order.order_id),{method:'PATCH',body:JSON.stringify({status:nextStatus})});await window.TihiyAdmin.reloadOrders();status('Статус заказа обновлён','ok')}
          catch(error){status(error.message,'error');nextButton.disabled=false}
        });
        quickActions.append(nextButton);
      }
      if(order.status!=='cancelled'&&order.status!=='completed'){
        const cancel=document.createElement('button');cancel.type='button';cancel.className='btn danger';cancel.textContent='Отменить заказ';
        cancel.addEventListener('click',async()=>{
          if(!confirm('Отменить заказ #'+order.order_id+'?'))return;
          cancel.disabled=true;
          try{await window.TihiyAdmin.api('/api/admin/orders/'+encodeURIComponent(order.order_id),{method:'PATCH',body:JSON.stringify({status:'cancelled'})});await window.TihiyAdmin.reloadOrders();status('Заказ отменён','ok')}
          catch(error){status(error.message,'error');cancel.disabled=false}
        });quickActions.append(cancel);
      }
      actionCard.append(statusHeading,quickActions);mainColumn.append(actionCard);

      const sideColumn=document.createElement('aside');sideColumn.className='admin-order-side-column';
      const clientCard=makeOrderCard('Информация о клиенте','client');
      const clientName=document.createElement('b');clientName.className='admin-client-name';clientName.textContent=order.customer_name||'Не указано';
      const clientPhone=document.createElement('p');clientPhone.className='admin-client-phone';clientPhone.textContent=order.phone||'Телефон не указан';
      const contactActions=document.createElement('div');contactActions.className='admin-contact-actions';
      if(phoneDigits){
        const call=document.createElement('a');call.href='tel:'+phoneDigits;call.className='admin-contact-button';call.textContent='☎ Позвонить';
        const whats=document.createElement('a');whats.href='https://wa.me/'+phoneDigits;whats.target='_blank';whats.rel='noopener';whats.className='admin-contact-button';whats.textContent='WhatsApp';
        contactActions.append(call,whats);
      }
      clientCard.append(clientName,clientPhone,contactActions);
      const receiveCard=makeOrderCard('Способ получения','receive');
      const methodBadge=document.createElement('div');methodBadge.className='admin-receive-method';
      const delivery=/достав/i.test(notes.fulfillment);
      methodBadge.textContent=delivery?'🚚  Доставка':'♧  Самовывоз';
      const timeLine=document.createElement('p');timeLine.className='admin-receive-time';timeLine.textContent='◷  '+(order.pickup_time||'Время не указано');
      receiveCard.append(methodBadge,timeLine);
      const addressNode=document.createElement('p');addressNode.className='admin-receive-address';
      const detailsForAddress=delivery?notes.address:(orderStoreSettings?.settings?.pickup_address||'с. Чарышское, Алтайский край');
      addressNode.textContent=delivery?(detailsForAddress?'Адрес доставки: '+detailsForAddress:'Адрес доставки не указан'):'Адрес магазина: '+detailsForAddress;
      receiveCard.append(addressNode);
      const mapQuery=detailsForAddress||'Чарышское, Алтайский край';
      const map=document.createElement('iframe');map.className='admin-order-map';map.title='Карта адреса заказа';map.loading='lazy';map.src='https://yandex.ru/map-widget/v1/?text='+encodeURIComponent(mapQuery);
      receiveCard.append(map);
      const mapLink=document.createElement('a');mapLink.className='admin-order-map-link';mapLink.href=delivery?'https://yandex.ru/maps/?text='+encodeURIComponent(mapQuery):(orderStoreSettings?.settings?.pickup_map_url||'https://yandex.ru/maps/?text='+encodeURIComponent(mapQuery));mapLink.target='_blank';mapLink.rel='noopener';mapLink.textContent='Открыть в картах ↗';receiveCard.append(mapLink);

      const history=makeOrderCard('История заказа','history');
      const historyList=document.createElement('div');historyList.className='admin-order-history';
      const created=document.createElement('div');created.className='admin-history-item done';
      const createdTime=document.createElement('time');createdTime.textContent=orderDate(order);
      const createdContent=document.createElement('div');const createdTitle=document.createElement('b');createdTitle.textContent='Заказ создан';const createdText=document.createElement('small');createdText.textContent='Заявка сохранена в магазине';createdContent.append(createdTitle,createdText);created.append(createdTime,createdContent);historyList.append(created);
      const currentHistory=document.createElement('div');currentHistory.className='admin-history-item current';
      const currentTime=document.createElement('time');currentTime.textContent='Сейчас';
      const currentContent=document.createElement('div');const currentTitle=document.createElement('b');currentTitle.textContent=statusNames[order.status]||'Статус заказа';
      const currentText=document.createElement('small');currentText.textContent='Текущий сохранённый статус';currentContent.append(currentTitle,currentText);currentHistory.append(currentTime,currentContent);historyList.append(currentHistory);
      history.append(historyList);
      sideColumn.append(clientCard,receiveCard,history);
      columns.append(mainColumn,sideColumn);
      const body=document.createElement('div');body.className='admin-order-body';body.append(progress,columns);orderDetail.append(body);

      if(notes.remainder){
        const note=document.createElement('section');note.className='admin-order-client-note';
        const noteTitle=document.createElement('h3');noteTitle.textContent='Комментарий клиента';
        const noteText=document.createElement('p');noteText.textContent=notes.remainder;note.append(noteTitle,noteText);orderDetail.append(note);
      }
      const printArea=document.createElement('section');printArea.className='admin-print-receipt';
      printArea.innerHTML='<h1>Тихий ролл</h1><h2>Заказ #'+safeText(order.order_id)+'</h2><p>'+safeText(orderDate(order))+'</p><hr>';
      (order.items||[]).forEach(item=>{const line=document.createElement('p');line.textContent=(item.name||item.id)+' × '+(item.qty||0)+' — '+money(item.subtotal??((item.qty||0)*Number(item.price||0)));printArea.append(line)});
      const grand=document.createElement('h2');grand.textContent='Итого: '+money(order.total);printArea.append(document.createElement('hr'),grand);
      printArea.append(document.createTextNode((order.customer_name||'')+' · '+(order.phone||'')));
      orderDetail.append(printArea);
      if(!orderStoreSettings&&!orderStoreSettingsPromise){
        loadOrderStoreSettings().then(()=>{if(selectedOrderId===order.order_id)renderOrderDetail(order)});
      }
    }
    function renderAnalytics(){
      const report=window.__TIHIY_ADMIN_REPORT__;analyticsRoot.replaceChildren();
      if(!report||!report.summary){const empty=document.createElement('div');empty.className='panel';empty.textContent='Загрузка статистики…';analyticsRoot.append(empty);return}
      const summary=report.summary;const daily=Array.isArray(summary.daily)?summary.daily.slice(-7):[];
      const kpis=document.createElement('div');kpis.className='admin-analytics-kpis';
      [['Выручка',money(summary.revenue),'Без отменённых заказов'],['Заказы',String(summary.orders_count||0),'Вся сохранённая история'],['Средний чек',money(summary.average_check||0),(summary.valid_orders_count||0)+' заказов в расчёте'],['Расчётная валовая прибыль',money(summary.gross_profit),'По сохранённой себестоимости']].forEach(([label,value,note])=>{
        const card=document.createElement('div');card.className='admin-kpi';const span=document.createElement('span');span.textContent=label;const strong=document.createElement('strong');strong.textContent=value;const small=document.createElement('small');small.textContent=note;card.append(span,strong,small);kpis.append(card);
      });
      analyticsRoot.append(kpis);
      const chart=panel('Выручка и количество заказов','Последние семь календарных дней по дате создания заказа.');
      const bars=document.createElement('div');bars.className='admin-analytics-bars';
      const max=Math.max(1,...daily.map(row=>Number(row.revenue)||0));
      daily.forEach(row=>{
        const col=document.createElement('div');col.className='admin-analytics-column';
        const amount=document.createElement('span');amount.className='admin-analytics-amount';amount.textContent=money(row.revenue||0);
        const track=document.createElement('div');track.className='admin-analytics-track';const bar=document.createElement('span');bar.className='admin-analytics-bar';bar.style.height=Math.max(3,(Number(row.revenue||0)/max)*100)+'%';track.append(bar);
        const date=document.createElement('small');date.textContent=new Date(row.date+'T12:00:00').toLocaleDateString('ru-RU',{weekday:'short',day:'numeric'});
        const count=document.createElement('em');count.textContent=(row.orders||0)+' зак.';
        col.append(amount,track,date,count);bars.append(col);
      });
      if(!daily.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Пока нет данных для графика.';chart.append(empty)}
      chart.append(bars);analyticsRoot.append(chart);
      const lower=document.createElement('div');lower.className='admin-analytics-lower';
      const statusPanel=panel('Статусы заказов','Текущие состояния по всей сохранённой истории.');
      const names={new:'Новые',accepted:'Приняты',preparing:'Готовятся',ready:'Готовы к выдаче',completed:'Выданы',cancelled:'Отменены'};
      const colors={new:'#3898ff',accepted:'#e9a13a',preparing:'#ff5148',ready:'#3cbf89',completed:'#697780',cancelled:'#a56b80'};
      Object.entries(names).forEach(([key,label])=>{const row=document.createElement('div');row.className='admin-status-row';const dot=document.createElement('i');dot.style.background=colors[key];const n=document.createElement('span');n.textContent=label;const value=document.createElement('b');value.textContent=String(summary.status_counts?.[key]||0);row.append(dot,n,value);statusPanel.append(row)});
      const popularPanel=panel('Популярные товары','Количество проданных позиций, без отменённых заказов.');
      (summary.popular_items||[]).slice(0,10).forEach((item,index)=>{const row=document.createElement('div');row.className='admin-popular-row';const rank=document.createElement('span');rank.className='admin-popular-rank';rank.textContent=String(index+1);const name=document.createElement('b');name.textContent=item.name;const qty=document.createElement('span');qty.textContent=(item.qty||0)+' шт.';row.append(rank,name,qty);popularPanel.append(row)});
      if(!(summary.popular_items||[]).length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Данные появятся после первых заказов.';popularPanel.append(empty)}
      lower.append(statusPanel,popularPanel);analyticsRoot.append(lower);
    }
    async function loadSettings(){
      const root=settingsRoot;root.replaceChildren();
      const loading=document.createElement('div');loading.className='panel';loading.textContent='Загружаем настройки магазина…';root.append(loading);
      try{
        const result=await window.TihiyAdmin.api('/api/admin/store-settings');
        settingsCache=result.settings;const integrations=result.integrations||{};
        root.replaceChildren();
        const grid=document.createElement('div');grid.className='admin-settings-grid';root.append(grid);
        const details=document.createElement('section');details.className='admin-settings-section';
        details.innerHTML='<h2>Информация о магазине</h2><div class="admin-settings-field"><label>Название</label><input id="cfgName" maxlength="80"></div><div class="admin-settings-field"><label>Телефон</label><input id="cfgPhone" maxlength="50"></div><div class="admin-settings-field"><label>Краткое описание</label><textarea id="cfgDescription" maxlength="300"></textarea></div>';
        grid.append(details);
        const pickup=document.createElement('section');pickup.className='admin-settings-section';
        pickup.innerHTML='<h2>Самовывоз</h2><div class="admin-settings-field"><label>Адрес точки</label><textarea id="cfgAddress" maxlength="300"></textarea></div><div class="admin-settings-field"><label>Ссылка на карту (HTTPS)</label><input id="cfgMap" maxlength="1000"></div><label class="admin-settings-check"><input id="cfgPickupEnabled" type="checkbox"> Самовывоз доступен</label>';
        grid.append(pickup);
        const delivery=document.createElement('section');delivery.className='admin-settings-section';
        delivery.innerHTML='<h2>Доставка</h2><label class="admin-settings-check"><input id="cfgDeliveryEnabled" type="checkbox"> Принимать заказы с доставкой</label><div class="admin-settings-field"><label>Минимальная сумма доставки, ₽</label><input id="cfgMinimum" type="number" min="0" max="100000"></div><div class="admin-settings-field"><label>Условия и примечание по доставке</label><textarea id="cfgDeliveryNote" maxlength="300"></textarea></div><h3>Зоны доставки и ориентировочная стоимость</h3><p class="muted">Стоимость отображается в настройках; окончательная сумма подтверждается владельцем отдельно.</p><div id="cfgZones"></div><button class="btn" type="button" id="cfgAddZone">＋ Добавить зону</button>';
        grid.append(delivery);
        const hours=document.createElement('section');hours.className='admin-settings-section';
        hours.innerHTML='<h2>График работы</h2><p class="muted">График используется для доступности дат и временных слотов при оформлении заказа.</p><div class="admin-settings-hours" id="cfgHours"></div>';
        grid.append(hours);
        const payments=document.createElement('section');payments.className='admin-settings-section';
        payments.innerHTML='<h2>Способы оплаты</h2><div class="admin-integration-row"><span>Наличные при получении</span><strong class="connected">Доступно</strong></div><div class="admin-integration-row"><span>Онлайн-оплата картой / СБП</span><strong class="'+(integrations.online_payments?'connected':'disconnected')+'">'+(integrations.online_payments?'Подключено':'Не подключено')+'</strong></div><p class="muted">Оплата онлайн не включается одним переключателем: для неё нужен платёжный провайдер и настройка ключей.</p>';
        grid.append(payments);
        const integration=document.createElement('section');integration.className='admin-settings-section';
        integration.innerHTML='<h2>Интеграции и уведомления</h2><div class="admin-integrations"><div class="admin-integration-row"><span>Telegram · получение заказов</span><strong class="'+(integrations.telegram_orders?'connected':'disconnected')+'">'+(integrations.telegram_orders?'Подключено':'Проверь BOT_TOKEN и ADMIN_CHAT_ID')+'</strong></div><div class="admin-integration-row"><span>Telegram · статусы для клиента</span><strong class="'+(integrations.telegram_customer_updates?'connected':'disconnected')+'">'+(integrations.telegram_customer_updates?'Доступен бот':'Не настроено')+'</strong></div><div class="admin-integration-row"><span>WhatsApp Business</span><strong class="disconnected">Не подключён</strong></div></div><p class="muted">Здесь показано состояние реальных настроек сервера, без демонстрационных переключателей.</p>';
        grid.append(integration);
        const saveBar=document.createElement('div');saveBar.className='formactions';saveBar.innerHTML='<button class="btn primary" type="button" id="cfgSave">Сохранить настройки магазина</button><span id="cfgSaveStatus" class="muted"></span>';root.append(saveBar);
        const s=settingsCache;
        $('#cfgName').value=s.shop_name||'';$('#cfgPhone').value=s.phone||'';$('#cfgDescription').value=s.description||'';
        $('#cfgAddress').value=s.pickup_address||'';$('#cfgMap').value=s.pickup_map_url||'';
        $('#cfgPickupEnabled').checked=s.pickup_enabled!==false;$('#cfgDeliveryEnabled').checked=s.delivery_enabled!==false;
        $('#cfgMinimum').value=Number(s.minimum_order||0);$('#cfgDeliveryNote').value=s.delivery_note||'';
        renderZones(Array.isArray(s.delivery_zones)?s.delivery_zones:[]);
        renderHours(Array.isArray(s.weekly_hours)?s.weekly_hours:[]);
        $('#cfgAddZone').addEventListener('click',()=>{const zones=readZones();zones.push({name:'Новая зона',fee:0,radius_km:0,active:true});renderZones(zones)});
        $('#cfgSave').addEventListener('click',async()=>{
          const button=$('#cfgSave'),notice=$('#cfgSaveStatus');button.disabled=true;notice.textContent='Сохраняем…';
          try{
            const payload={
              shop_name:$('#cfgName').value.trim(),phone:$('#cfgPhone').value.trim(),description:$('#cfgDescription').value.trim(),
              pickup_address:$('#cfgAddress').value.trim(),pickup_map_url:$('#cfgMap').value.trim(),
              pickup_enabled:$('#cfgPickupEnabled').checked,delivery_enabled:$('#cfgDeliveryEnabled').checked,
              minimum_order:Number($('#cfgMinimum').value||0),delivery_note:$('#cfgDeliveryNote').value.trim(),
              delivery_zones:readZones(),weekly_hours:readHours()
            };
            const saved=await window.TihiyAdmin.api('/api/admin/store-settings',{method:'PUT',body:JSON.stringify(payload)});
            settingsCache=saved.settings;notice.textContent='Настройки сохранены';notice.className='connected';
            window.dispatchEvent(new CustomEvent('tihiy:store-settings-saved'));
          }catch(error){notice.textContent=error.message;notice.className='disconnected'}
          finally{button.disabled=false}
        });
        settingsLoaded=true;
      }catch(error){
        root.replaceChildren();const box=document.createElement('div');box.className='panel';box.textContent='Не удалось загрузить настройки: '+error.message;root.append(box);
      }
      function renderZones(zones){
        const zoneRoot=$('#cfgZones');zoneRoot.replaceChildren();
        zones.forEach((zone,index)=>{
          const row=document.createElement('div');row.className='admin-zone-row';row.dataset.index=String(index);
          row.innerHTML='<input data-zone-name placeholder="Название зоны" aria-label="Название зоны"><input data-zone-fee type="number" min="0" max="20000" aria-label="Стоимость"><input data-zone-radius type="number" min="0" max="100" step="0.1" aria-label="Радиус, км"><button type="button" class="btn danger" data-zone-remove aria-label="Удалить зону">×</button>';
          $('[data-zone-name]',row).value=zone.name||'';$('[data-zone-fee]',row).value=Number(zone.fee||0);$('[data-zone-radius]',row).value=Number(zone.radius_km||0);
          $('[data-zone-remove]',row).addEventListener('click',()=>{const next=readZones();next.splice(index,1);renderZones(next)});
          zoneRoot.append(row);
        });
      }
      function readZones(){return $$('.admin-zone-row',$('#cfgZones')).map(row=>({name:$('[data-zone-name]',row).value.trim(),fee:Number($('[data-zone-fee]',row).value||0),radius_km:Number($('[data-zone-radius]',row).value||0),active:true})).filter(row=>row.name)}
      function renderHours(hours){
        const root=$('#cfgHours');root.replaceChildren();
        const defaults=['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
        defaults.forEach((day,index)=>{
          const row=document.createElement('div');row.className='admin-hour-row';row.dataset.day=String(index);
          const source=hours[index]||{day,open:'12:00',close:'21:00',closed:index===2||index===6};
          row.innerHTML='<span></span><input type="time" data-open aria-label="Открытие"><input type="time" data-close aria-label="Закрытие"><label><input type="checkbox" data-closed> Выходной</label>';
          $('span',row).textContent=day;$('[data-open]',row).value=source.open||'';$('[data-close]',row).value=source.close||'';$('[data-closed]',row).checked=!!source.closed;
          const toggle=()=>{const closed=$('[data-closed]',row).checked;$('[data-open]',row).disabled=closed;$('[data-close]',row).disabled=closed};
          $('[data-closed]',row).addEventListener('change',toggle);toggle();root.append(row);
        });
      }
      function readHours(){
        return $$('.admin-hour-row',$('#cfgHours')).map(row=>({day:$('span',row).textContent,open:$('[data-open]',row).value,close:$('[data-close]',row).value,closed:$('[data-closed]',row).checked}));
      }
    }

    window.addEventListener('tihiy:catalog-rendered',()=>renderHome());
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();