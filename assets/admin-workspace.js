(function(){
  const $ = (id) => document.getElementById(id);
  function makePage(id,title,subtitle){
    const page=document.createElement('section');
    page.className='admin-page'+(id==='home'?' active':'');
    page.dataset.page=id;
    if(title){
      const heading=document.createElement('div');
      heading.className='admin-page-title';
      const copy=document.createElement('div');
      const h=document.createElement('h1');h.textContent=title;
      const p=document.createElement('p');p.textContent=subtitle||'Тихий ролл · панель владельца';
      copy.append(h,p);heading.append(copy);page.append(heading);
    }
    return page;
  }
  function init(){
    const wrap=document.querySelector('main.wrap');
    const app=$('app');
    if(!wrap||!app||wrap.dataset.premiumReady==='1')return;
    wrap.dataset.premiumReady='1';
    const head=wrap.querySelector('.head');
    const status=$('status');
    const foot=wrap.querySelector('.foot');
    const sitePanel=$('reloadContent')?.closest('.panel');
    const panels=[...app.children].filter(el=>el!==$('editor'));
    const productsPanel=panels[0];
    const ordersPanel=panels[1];
    const categoriesPanel=panels[2];
    const editor=$('editor');
    const shell=document.createElement('div');shell.className='admin-shell';
    const sidebar=document.createElement('aside');sidebar.className='admin-sidebar';
    sidebar.innerHTML='<div class="admin-logo"><span>Т</span> ТИХИЙ РОЛЛ<small>АДМИН-ПАНЕЛЬ</small></div><nav class="admin-nav" aria-label="Разделы админ-панели"></nav><div class="admin-sidebar-foot">Панель владельца<br>Данные загружаются с сервера</div>';
    const nav=sidebar.querySelector('.admin-nav');
    const main=document.createElement('div');main.className='admin-main';
    wrap.insertBefore(shell,head);
    shell.append(sidebar,main);
    main.append(head,status,app);
    if(foot)main.append(foot);
    const home=makePage('home','Главная админ-панели','Обзор магазина и быстрый доступ к ежедневным задачам');
    home.innerHTML += '<div class="admin-home-hero"><div><h2>Тихий ролл · панель владельца</h2><p>Управляй заказами, меню и оформлением магазина из одного места.</p></div><div class="admin-home-actions"><button class="btn primary" type="button" data-go="orders">Открыть заказы</button><button class="btn" type="button" data-go="products">Добавить товар</button></div></div><div class="admin-home-kpis"><div class="admin-home-kpi"><span>Товаров в меню</span><strong id="homeProductCount">—</strong></div><div class="admin-home-kpi"><span>Состояние доступа</span><strong id="homeAccess">Проверяется</strong></div><div class="admin-home-kpi"><span>Сводка заказов</span><strong id="homeOrders">Загружается</strong></div></div><div class="panel"><div class="toolbar"><div><h2 style="margin:0">Быстрые действия</h2><p class="muted">Открывай нужный раздел одним нажатием.</p></div></div><div class="admin-home-shortcuts"><button class="admin-home-shortcut" type="button" data-go="orders"><i>▤</i><span><b>Заказы</b><small>Проверить новые и обновить статусы</small></span></button><button class="admin-home-shortcut" type="button" data-go="products"><i>🍣</i><span><b>Товары</b><small>Цены, фотографии и состав</small></span></button><button class="admin-home-shortcut" type="button" data-go="store"><i>▧</i><span><b>Главная и баннеры</b><small>Слайды и готовые сеты</small></span></button></div></div>';
    const pageOrders=makePage('orders','Заказы','Новые заказы, приготовление и выдача');
    const pageProducts=makePage('products','Товары','Ассортимент, фотографии, состав и цены');
    const pageStore=makePage('store','Категории и оформление','Категории меню, готовые сеты и рекламные блоки');
    if(productsPanel)pageProducts.append(productsPanel);
    if(editor)pageProducts.append(editor);
    if(ordersPanel)pageOrders.append(ordersPanel);
    if(categoriesPanel)pageStore.append(categoriesPanel);
    if(sitePanel){sitePanel.id='siteContentPanel';pageStore.append(sitePanel)}
    app.replaceChildren(home,pageOrders,pageProducts,pageStore);
    const navItems=[
      ['home','⌂','Главная'],
      ['orders','▤','Заказы'],
      ['products','▦','Товары'],
      ['store','✦','Категории и баннеры']
    ];
    function activate(id){
      app.querySelectorAll('.admin-page').forEach(p=>p.classList.toggle('active',p.dataset.page===id));
      nav.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.go===id));
      try{sessionStorage.setItem('tihiy-admin-page',id)}catch(_){}
      window.scrollTo({top:0,behavior:'smooth'});
    }
    navItems.forEach(([id,icon,label])=>{
      const b=document.createElement('button');b.type='button';b.dataset.go=id;
      const i=document.createElement('span');i.className='nav-icon';i.textContent=icon;
      const t=document.createElement('span');t.textContent=label;b.append(i,t);
      b.addEventListener('click',()=>activate(id));nav.append(b);
    });
    sidebar.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>activate(b.dataset.go)));
    home.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>{
      const id=b.dataset.go;activate(id);
      if(id==='products'&&$('add'))$('add').focus({preventScroll:true});
    }));
    const observer=new MutationObserver(()=>{
      if($('analyticsSummary'))$('homeOrders').textContent=$('analyticsSummary').textContent.replace(/^Заказов:\s*/,'').slice(0,45)||'Нет данных';
      if($('status')&&$('status').classList.contains('ok'))$('homeAccess').textContent='Доступ подтверждён';
      if($('list'))$('homeProductCount').textContent=$('list').querySelectorAll('.row').length||'0';
    });
    if($('analyticsSummary'))observer.observe($('analyticsSummary'),{childList:true,subtree:true,characterData:true});
    if($('list'))observer.observe($('list'),{childList:true,subtree:true});
    if($('status'))observer.observe($('status'),{childList:true,subtree:true,attributes:true});
    const preferred=(()=>{try{return sessionStorage.getItem('tihiy-admin-page')}catch(_){return null}})();
    activate(navItems.some(x=>x[0]===preferred)?preferred:'home');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();