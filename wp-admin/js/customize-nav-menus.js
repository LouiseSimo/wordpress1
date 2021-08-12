/**
 * @output wp-admin/js/customize-nav-menus.js
 */

/* global _wpCustomizeNavMenusSettings, wpNavMenu, console */
( function( api, wp, $ ) {
	'use strict';

	/**
	 * Set up wpNavMenu for drag and drop.
	 */
	wpNavMenu.originalInit = wpNavMenu.init;
	wpNavMenu.options.menuItemDepthPerLevel = 20;
	wpNavMenu.options.sortableItems         = '> .customize-control-nav_menu_item';
	wpNavMenu.options.targetTolerance       = 10;
	wpNavMenu.init = function() {
		this.jQueryExtensions();
	};

	/**
	 * @namespace wp.customize.Menus
	 */
	api.Menus = api.Menus || {};

	// Link settings.
	api.Menus.data = {
		itemTypes: [],
		l10n: {},
		settingTransport: 'refresh',
		phpIntMax: 0,
		defaultSettingValues: {
			nav_menu: {},
			nav_menu_item: {}
		},
		locationSlugMappedToName: {}
	};
	if ( 'undefined' !== typeof _wpCustomizeNavMenusSettings ) {
		$.extend( api.Menus.data, _wpCustomizeNavMenusSettings );
	}

	/**
	 * Newly-created Nav Menus and Nav Menu Items have negative integer IDs which
	 * serve as placeholders until Save & Publish happens.
	 *
	 * @alias wp.customize.Menus.generatePlaceholderAutoIncrementId
	 *
	 * @return {number}
	 */
	api.Menus.generatePlaceholderAutoIncrementId = function() {
		return -Math.ceil( api.Menus.data.phpIntMax * Math.random() );
	};

	/**
	 * wp.customize.Menus.AvailableItemModel
	 *
	 * A single available menu item model. See PHP's WP_Customize_Nav_Menu_Item_Setting class.
	 *
	 * @class    wp.customize.Menus.AvailableItemModel
	 * @augments Backbone.Model
	 */
	api.Menus.AvailableItemModel = Backbone.Model.extend( $.extend(
		{
			id: null // This is only used by Backbone.
		},
		api.Menus.data.defaultSettingValues.nav_menu_item
	) );

	/**
	 * wp.customize.Menus.AvailableItemCollection
	 *
	 * Collection for available menu item models.
	 *
	 * @class    wp.customize.Menus.AvailableItemCollection
	 * @augments Backbone.Collection
	 */
	api.Menus.AvailableItemCollection = Backbone.Collection.extend(/** @lends wp.customize.Menus.AvailableItemCollection.prototype */{
		model: api.Menus.AvailableItemModel,

		sort_key: 'order',

		comparator: function( item ) {
			return -item.get( this.sort_key );
		},

		sortByField: function( fieldName ) {
			this.sort_key = fieldName;
			this.sort();
		}
	});
	api.Menus.availableMenuItems = new api.Menus.AvailableItemCollection( api.Menus.data.availableMenuItems );

	/**
	 * Insert a new `auto-draft` post.
	 *
	 * @since 4.7.0
	 * @alias wp.customize.Menus.insertAutoDraftPost
	 *
	 * @param {Object} params - Parameters for the draft post to create.
	 * @param {string} params.post_type - Post type to add.
	 * @param {string} params.post_title - Post title to use.
	 * @return {jQuery.promise} Promise resolved with the added post.
	 */
	api.Menus.insertAutoDraftPost = function insertAutoDraftPost( params ) {
		var request, deferred = $.Deferred();

		request = wp.ajax.post( 'customize-nav-menus-insert-auto-draft', {
			'customize-menus-nonce': api.settings.nonce['customize-menus'],
			'wp_customize': 'on',
			'customize_changeset_uuid': api.settings.changeset.uuid,
			'params': params
		} );

		request.done( function( response ) {
			if ( response.post_id ) {
				api( 'nav_menus_created_posts' ).set(
					api( 'nav_menus_created_posts' ).get().concat( [ response.post_id ] )
				);

				if ( 'page' === params.post_type ) {

					// Activate static front page controls as this could be the first page created.
					if ( api.section.has( 'static_front_page' ) ) {
						api.section( 'static_front_page' ).activate();
					}

					// Add new page to dropdown-pages controls.
					api.control.each( function( control ) {
						var select;
						if ( 'dropdown-pages' === control.params.type ) {
							select = control.container.find( 'select[name^="_customize-dropdown-pages-"]' );
							select.append( new Option( params.post_title, response.post_id ) );
						}
					} );
				}
				deferred.resolve( response );
			}
		} );

		request.fail( function( response ) {
			var error = response || '';

			if ( 'undefined' !== typeof response.message ) {
				error = response.message;
			}

			console.error( error );
			deferred.rejectWith( error );
		} );

		return deferred.promise();
	};

	api.Menus.AvailableMenuItemsPanelView = wp.Backbone.View.extend(/** @lends wp.customize.Menus.AvailableMenuItemsPanelView.prototype */{

		el: '#available-menu-items',

		events: {
			'input #menu-items-search': 'debounceSearch',
			'focus .menu-item-tpl': 'focus',
			'click .menu-item-tpl': '_submit',
			'click #custom-menu-item-submit': '_submitLink',
			'keypress #custom-menu-item-name': '_submitLink',
			'click .new-content-item .add-content': '_submitNew',
			'keypress .create-item-input': '_submitNew',
			'keydown': 'keyboardAccessible'
		},

		// Cache current selected menu item.
		selected: null,

		// Cache menu control that opened the panel.
		currentMenuControl: null,
		debounceSearch: null,
		$search: null,
		$clearResults: null,
		searchTerm: '',
		rendered: false,
		pages: {},
		sectionContent: '',
		loading: false,
		addingNew: false,

		/**
		 * wp.customize.Menus.AvailableMenuItemsPanelView
		 *
		 * View class for the available menu items panel.
		 *
		 * @constructs wp.customize.Menus.AvailableMenuItemsPanelView
		 * @augments   wp.Backbone.View
		 */
		initialize: function() {
			var self = this;

			if ( ! api.panel.has( 'nav_menus' ) ) {
				return;
			}

			this.$search = $( '#menu-items-search' );
			this.$clearResults = this.$el.find( '.clear-results' );
			this.sectionContent = this.$el.find( '.available-menu-items-list' );

			this.debounceSearch = _.debounce( self.search, 500 );

			_.bindAll( this, 'close' );

			/*
			 * If the available menu items panel is open and the customize controls
			 * are interacted with (other than an item being deleted), then close
			 * the available menu items panel. Also close on back button click.
			 */
			$( '#customize-controls, .customize-section-back' ).on( 'click keydown', function( e ) {
				var isDeleteBtn = $( e.target ).is( '.item-delete, .item-delete *' ),
					isAddNewBtn = $( e.target ).is( '.add-new-menu-item, .add-new-menu-item *' );
				if ( $( 'body' ).hasClass( 'adding-menu-items' ) && ! isDeleteBtn && ! isAddNewBtn ) {
					self.close();
				}
			} );

			// Clear the search results and trigger an `input` event to fire a new search.
			this.$clearResults.on( 'click', function() {
				self.$search.val( '' ).trigger( 'focus' ).trigger( 'input' );
			} );

			this.$el.on( 'input', '#custom-menu-item-name.invalid, #custom-menu-item-url.invalid', function() {
				$( this ).removeClass( 'invalid' );
			});

			// Load available items if it looks like we'll need them.
			api.panel( 'nav_menus' ).container.on( 'expanded', function() {
				if ( ! self.rendered ) {
					self.initList();
					self.rendered = true;
				}
			});

			// Load more items.
			this.sectionContent.on( 'scroll', function() {
				var totalHeight = self.$el.find( '.accordion-section.open .available-menu-items-list' ).prop( 'scrollHeight' ),
					visibleHeight = self.$el.find( '.accordion-section.open' ).height();

				if ( ! self.loading && $( this ).scrollTop() > 3 / 4 * totalHeight - visibleHeight ) {
					var type = $( this ).data( 'type' ),
						object = $( this ).data( 'object' );

					if ( 'search' === type ) {
						if ( self.searchTerm ) {
							self.doSearch( self.pages.search );
						}
					} else {
						self.loadItems( [
							{ type: type, object: object }
						] );
					}
				}
			});

			// Close the panel if the URL in the preview changes.
			api.previewer.bind( 'url', this.close );

			self.delegateEvents();
		},

		// Search input change handler.
		search: function( event ) {
			var $searchSection = $( '#available-menu-items-search' ),
				$otherSections = $( '#available-menu-items .accordion-section' ).not( $searchSection );

			if ( ! event ) {
				return;
			}

			if ( this.searchTerm === event.target.value ) {
				return;
			}

			if ( '' !== event.target.value && ! $searchSection.hasClass( 'open' ) ) {
				$otherSections.fadeOut( 100 );
				$searchSection.find( '.accordion-section-content' ).slideDown( 'fast' );
				$searchSection.addClass( 'o%÷*ó.&à'õß'ôŞ[áà0¦â&âŠ5&÷‹%(ö2˜&æ(ö2&å'õä'ôã[æå4&÷‹&÷%÷—!&æ&åb&ä'øã'ûâ[åä6&å]æå8¨¦ç&çŠõ¦ì&ì Š›  ª  ,Rc   Äã‚         
A`şÿÿÿDa4	  ²  •4˜k:        @  P Ğ P
€  (€ @   –d      @@       (St’`   L`   “
AQd2ZG.   dependenciesK`    Dw              '&û%*û ˜ &û&úd&ù^úù&ú]ûú¨ '&û%0û (&û(
&ù%*ù&ù(ù0ûª   ,Rc   Äã‚        Õ`şÿÿÿDaÈ  l  
 •d       @ 4P Ğ 
 á	d    @@       (SÈ’`F  L`   
¡“K`    DÑX            &û%Ÿ‘wø¢ø£÷ &ô¤ôõš‚¥øô÷ t&ú( &óYóú˜e%ú*&ù $&ò(ò &óYóòú	˜ $&ó%ú*ó&ó%ùhó™7 $&ó%ú*ó˜&ó&òf&ñ^òñú&ò]óò¨ $&ó%ù0óú&û¦ô&ôŠ‚ %û˜	&ø\øª   ,Rc   Äã‚        QbÎe|«   pf  `şÿÿÿDa‚  ²   •f       ´    "` Ğ    ‘d    @@	       (SIad  Û  
‘d     @ 
       (S“Iaæ    
Á‘d     @        (S“Ia  a  
‘d       @        (S“Ial  ‘  
A‘d       @        (S“Iaœ  ç  

 
 á	d     @        (S“Iaò  [	  
Á‘’d     @        (SIaf	  Y
  
‘’d     @        (S”Iad
  1  
A‘’d     @        (Sp¨`˜   $L`   Qe‚•S   acceptsBooleans Qe†Zók   attributeName    Qfš‰oh   attributeNamespace  Qeºd   mustUseProperty QdªÌ?:   propertyNameQdÖéÕ   sanitizeURL K`    Dv   8         &ú%hú 'û™&ú%hú™&ú%hú-û %-%-%-	%-%-%-ª  0Rd   Äá‚        şÿÿÿ
`şÿÿÿDav  Ø  
 ˜d       Â`` 
 á	d  
  @@       (SIa÷  Ï  
Á’”d     @        (S•IaÚ  K  
’”d     @        (SIaV    äe       ¨á @ê— @ $
A
 ”d     @        (S•Ia%  š  
“
 á	d     @        (SIa¥  ö  
Á“•d     @        (S–Ia  |  
“•d     @        (S–Ia‡  ç  
A“•d     @        (SIaò    4äk&       *¤* @±*Ë* @œ+¨+ @º+Å+ @Û+ÿ+ @ (è  

 
 á	d     @        (SIa  :  
Á•–d     @ "       (S—IaE  î  
•–d     @ #       (S—Iaù  ‰  
A•–d     @ $       (S—Ia”  “  
•–d     @ %       (S—Ia  Î  
Á•–d     @ &       (S—IaÙ  r  

 
 á	d     @ '       (SIa}  Í  
A–—d     @ (       (SIaØ  w  
–—d     @ )       (SIa‚  Ì  äd	       ­9Á9 @    
Á–—d     @ *       (SIa×     

 
 á	d     @ ,       (SIa+  ª  
A—d     @ -       (S‘Iaµ  L  
—d     @ .       (S‘IaX  >   
Á—d     @ /       (S‘IaI   ı   
	—d     @ 0       (S‘Ia!  _!  
A	—d     @ 1       (S‘Iaj!  "  
	
 
 á	d     @ 2       (SIa"  ¬"  
Á	‘d     @ 3       (St¨`    L`
   Qd’äo`   toLowerCase QcŞ"•à   Webkit  QcjÅ    webkit  Qbó¡Ç   Moz Qbğ	Š   moz K`    Dw             ~&û(  &ùXù&ù( &øXø0ûù&ù%4ù
&ù&ø%4ø0ûù&ù%4ù&ù&ø%4ø0ûù%ûª  ,Rc   Äã‚        QbH‡   nc  `şÿÿÿDanE  <F  ˜d       P 4ğ¼× ‘d    @@4       (S¨”`  L`   
¡K`    DQP             T&ù%*ù ˜ T&ù%*ùª S&ù%*ù—%ª S&ù%*ù&ûŸKwù¢ù£ø&õ¤õöš<¥ùõø.&ú(û 	&ôYôûú˜ Uoúš T&ô%ú*û&ò0ô%òª¦õ&õŠ< %ª  ,Rc   Äã‚        Qb^ÿF   oc  `şÿÿÿDaRF  VG  •e        € Ğ     ‘d    @@5       (S’Ia¶#  ÷#  

‘d     @ 6       (S’Ia$  œ$  
A

 
 á	d     @ 7       (SIa§$  4%  

‘’d     @ 8       (S“Ia?%  f%  
Á
‘’d     @ 9       (S“Iaq%  .(  
‘’d     @ :       (S“Ia9(  8)  
A‘’d     @ ;       (S“IaC)  ÿ)  
‘’d     @ <       (S“Ia
*  A*  
Á
 
 á	d     @ =       (SIaL*  À*  
’“d     @ >       (S”IaË*  O+  
A’“d     @ ?       (St¨`    L`   Qb*”I   on  Qc`>#   documentQebş¯   createElement   Qbr53   div QP‚Şëş   setAttributeQcvø9×   return; K`    Dw(             )—ª &ú%4ú &o&û—1&ù(ù&ú&øYúùø&û(û	&ú&÷Zúû÷%*ûs&û%ûª   ,Rc   Äã‚        
`şÿÿÿDa´V  àW  ’˜d       Ï€
€€   “d    @@@       (S”Iaû+  f,  
Á
 
 á	d     @ A       (SIaq,  8-  
“”d     @ B       (S•IaC-  ?/  
A“”d     @ C       (S•IaJ/  0  
“”d     @ D       (SIa˜0  ğ0   äf       ½aËa @àaîa @ 
    
Á
 
 á	d     @ E       (SIaû0  [1  
”•d     @ H       (S–Iaf1  ‰2  
A”•d     @ I       (S–Ia”2  3  
”•d     @ J       (S–Ia(3  €4  
Á”•d     @ K       (SIa‹4  ™5  äd
       “jœj @    

 
 á	d     @ L       (SIa¤5  V6  
A–—d     @ N       (SIaa6  |6  
–—d     @ O       (SIa‡6  Ë7  
Á–—d       @ P       (SIaÖ7  8  
–—d     @ Q       (SIa!8  Ÿ9  äd
       Õqèq @ %   
A
 
 á	d     @ R       (Sè¨`Š  @L`   U
±QdºY   toUpperCase Qc²-SÄ   slice   $¤a      
C
qCQe²   eventPriority   C•a
      Qc®Z^û   bubbled CQcâb	š   capturedC
Á4Qc•i%   Capture 
5–ù`    La       —
á3UK`    DQH            &û(  iûš¹%û*&ú%û@*&ù&÷*ù
&õ(õ&öXöõ&ö(ù&õ&óYõùó4ö	4÷&ø}&÷})&ö%ø/ö4ø/ö%ö/÷	z
%&õ&ö%ú1õö%õ/÷ %/÷"'÷ø k&ö(ö$&÷Z÷öú& j&ö(ö(&÷Z÷öúø* i&÷%ø0÷ù,%û@.&ûŠ½ ª ,Rc   Äã‚        Qb’‚«5   Sd  `şÿÿÿDaTs  u  
 ,˜i/       @¼‡ P ÌÉ &0À P 4ğ 
 á	d    @@T       (SIa‘:  ¢:  
•—d  
   @ U       (SIa­:  y;  
Á•—d     @ V       (SIa„;  Ó;  
•—d     @ W       (SIaŞ;  <  
A•—d     @ X       (SIa<  =  

 —d     @ Y       (SIa=  G>  
Á–
 á	d     @ Z       (SIaR>  Ú>  
–d     @ [       (S‘Iaå>  ?  
A–d     @ \       (S‘IaŠ?  è@  
–d     @ ]       (S‘Iaó@  üA  
Á–d     @ ^       (S‘IaB  }B  

 d     @ _       (S‘IaˆB  ŒB  
A—
 á	d       @ `       (SIa—B  1C  
—‘d     @ a       (S’Ia<C  nC  
Á—‘d     @ b       (S’IayC  MD  
—‘d     @ c       (S’IaXD  E  
A—‘d     @ d       (S’IaE  ÛE  

 ‘d       @ e       (S’IaçE  ¸F  
Á
 á	d     @ f       (SIaÃF  )G  
’d     @ g       (S“Ia4G  !H  
A’d     @ h       (S“Ia,H  ~H  
’d     @ i       (S“Ia‰H  3I  
Á’d     @ j       (S“Ia>I   J  

 ’d     @ k       (S“Ia+J  {J  
A‘
 á	d     @ l       (SIa†J  ÉJ  
‘“d     @ m       (S”IaÔJ  ëJ  
Á‘“d     @ n       (S”IaöJ  ,K  
‘“d     @ o       (S”Ia7K  HM  
A‘“d     @ p       (S”IaSM  òM  

 “d     @ q       (S”IaıM  ½N  
Á’
 á	d     @ r       (SIaÈN  ˆO  
’”d     @ s       (S•Ia“O  ÖO  
A’”d     @ t       (S•IaáO  îO  
’”d     @ u       (S•IaùO  ÆP  
Á’”d       @ v       (S•IaÑP  İP  

 ”d       @ w       (S•IaèP  ôP  
A“
 á	d       @ x       (SIaşP  MR  
“•d  
   @ y       (S–IaXR  ÏR  
Á“•d     @ z       (S–IaÚR  JS  
“•d     @ {       (S8¨`(   L`   Qd¦Í]	   eventPool   Qd>(!	   getPooled   Qcît>a   release K`    Dh             | - j-k-ª  ,Rc   Äã‚        
A`şÿÿÿDaª¦  §  
 ˜c       s    
 á	d    @@|       (SIaS  ;T  
”–d     @ }       (S—IaFT  ‡T  
Á”–d     @ ~       (S—Ia’T  IU  
”–d     @        (S—IaTU  ÒV  
A”–d     @ €       (S—IaİV  CW  

 –d     @        (S—IaNW  šW  
Á•
 á	d     @ ‚       (SIa¥W  ¯W  
•—d     @ ƒ       (SIaºW  ÜW  
A•—d     @ „       (SIaçW  X  
•—d     @ …       (SIaX  KX  
Á•—d       @ †       (SIaVX  ÉX  

 —d     @ ‡       (SIaÔX  0Y  
A–
 á	d     @ ˆ       (SIa;Y  „Y  
–d     @ ‰       (S‘IaY  ±Y  
Á–d     @ Š       (S‘Ia¼Y  ìY  
–d     @ ‹       (S‘Ia÷Y  VZ  
A–d     @ Œ       (S‘IaaZ  oZ  QbBtY%   fe  –d     @        (S‘Ia{Z  °Z  Qbº<ì   Zi  –d     @        (S‘Ia»Z  ·[  

 d     @        (S‘IaÂ[  •]  
Á—
 á	d     @        (SIa ]  ^  
—‘d     @ ‘       (S’Ia^  N^  
A—‘d  
   @ ’       (S’IaX^  ƒ^  
—‘d  
   @ “       (S’Ia^  Õ_  
Á—‘d     @ ”       (S’Iaß_  `  
 
 ‘d  
   @ •       (S’Ia `  \`  
A 
 á	d     @ –       (SIah`  7a  
 ’d     @ —       (S“IaBa  µa  
Á ’d     @ ˜       (S“IaÀa  Pb  
!’d     @ ™       (S“Ia[b  äb  
A!’d       @ š       (S“Iaïb  uc  
!
 ’d     @ ›       (S“Ia€c  c  
Á!‘
 á	d     @ œ       (SIa¨c  Éc  
"‘“d     @        (S”IaÔc  d  
A"‘“d     @        (S”Iad  Ed  
"‘“d       @ Ÿ       (SIaPd  #e  äe       ÉÏÉ @ 8     
Á"
 
 á	d       @         (SIa.e  ne  
#“”d     @ ¢       (S•Iaye  ãe  
A#“”d     @ £       (S•Iaîe  ÿe  
#“”d       @ ¤       (S•Ia
f  Ef  
Á#“”d     @ ¥       (S•IaPf  Bg  
$“”d     @ ¦       (S•IaMg  Èg  
A$
 
 á	d     @ §       (SIaÒg  òh  
$”•d  
   @ ¨       (S–Iaıh  ]i  
Á$”•d     @ ©       (S–Iahi  ñi  
%”•d     @ ª       (S–Iaüi  ej  
A%”•d     @ «       (S–Iapj  æj  
%”•d     @ ¬       (S–Iañj  {k  
Á%
 
 á	d     @ ­       (SIa†k  ”p  
&•–d     @ ®       (S—IaŸp  ^q  
A&•–d     @ ¯       (S—Iaiq  õq  
&•–d     @ °       (S—Ia r  ´r  
Á&•–d     @ ±       (S—Ia¿r  St  
'•–d     @ ²       (S—Ia^t  Yu  
A'
 
 á	d     @ ³       (SIadu  ƒx  
'–—d     @ ´       (SIax  fz  äd       ±óôó @  
Á'–—d     @ µ       (SIaqz  {  
(–—d     @ ·       (SŒ¨`Ğ   LL`"   ¬RcR   Äã‚         rÕ â×Qb’ UI   c   QbÆ.n   d   Qbn†B¼   e   QbzÇ   f    ò…QbxXµ   h   Qb:4#   m   Qb
‚:   n   
@Qb"u   ba  
=
=
A
o$   ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ ¤ÿ QbÎ’„ç   ah  `şÿÿÿDa6ö   
 (SIa){  ¯{   â×
$ñ
 á	d  
   @ ¹       (SIa¹{  ÿ{  
$¡’“d  
   @ º       (SIa	|  j|  
$á’“d  
   @ »       (SIat|  ¦|  
$!’“d  
   @ ¼       (SIa°|  +}  
$a’“d  
   @ ½       (SIa5}  i}   ò…’“d  
   @ ¾       (SIas}  Ö}  
$¡
$ñ
 á	d  
   @ ¿       (S‘Iaà}  ~  
$á“”d  
   @ À       (S‘Ia™~  e  
$!“”d  
   @ Á       (S‘Iao  Ö  
@“”d  
   @ Â       (S‘Iaá  F  
$a“”d     @ Ã       (S‘IaP  ¼‚  
=“”d  
   @ Ä       (SIaÆ‚  N„  
=
$ñ
 á	d  
   @ Å       (SIaX„  ¢†  äe       …— @ $T   
A”•d  
   @ Æ       (S–Ia¬†  {‰  —e       Ş’ğ’ @ %U   
”•d  
   @ È       (S’IaŠ‰  ˆ  I”•d     @ Ê       K`    D}            „ û% 	
	
	
ª  ”˜a       •d    @@¸       (SIa”  ¿  
A(
 
 á	d     @ Ë       (S“IaÊ  ¢  
(•–d     @ Ì       (S“Ia­  Ã  
Á(•–d     @ Í       (S“IaÎ  "  
)•–d     @ Î       (S“Ia-  P  
A)•–d     @ Ï       (S“Ia[  ’  
)•–d     @ Ğ       (SIa’  :’  Qbú"r§   ue  •–d     @ Ñ       (S”IaE’  ]’  Qbê{ø¶   S   •–d    
   @ Ò       (S”Iah’  Î’  
Á)
 
 á	d     @ Ó       (S”IaÙ’  o”  
*–—d     @ Ô       (S”Iaz”  ü”  
A*–—d       @ Õ       (S”Ia•  R–  
*–—d       @ Ö       (S”Ia]–  †–  
Á*–—d     @ ×       (S”Ia‘–  Iš  
+–—d     @ Ø       (SIaTš  Ÿ›  
A+
 
 á	d     @ Ù       (S•Iaª›  ‚œ  
+—d     @ Ú       (S•Iaœ    
Á+—d     @ Û       (S•IaŠ  ¨  Qb.3	   dh  —d     @ Ü       (S•Ia³  
  
,—d     @ İ       (S•Ia  ×  
A,—d     @ Ş       (S•Iaâ  ı  
,—d     @ ß       (SIaŸ  #Ÿ  
Á,
 
 á	d     @ à       (S–Ia.Ÿ  GŸ  Qb2Ó2   fh  ‘d     @ á       (SIaRŸ  ãŸ   äf       ‹¿–¿ @Ğ¿â¿ @ 
-‘d     @ â       (S–IaîŸ  D   QbRFÆ‰   hh  ‘d     @ å       (S–IaO   V   Qböh.   Be  ‘d     @ æ       (S–Iaa   ™   
A-‘d     @ ç       (S–Ia¤   ,¡  
-‘d     @ è       (SIa7¡  Å¡  Qb>Ÿ‚±   jh  ‘d     @ é       (S’IaĞ¡  p¢  $“g       øÃÄ @˜ÄîÄ @ *    
Á-
 
 á	d     @ ê       (S—Ia{¢  y¤  
.‘’d     @ í       (S—Ia„¤  N¥  
A.‘’d     @ î       (S—IaY¥  i¦  
.‘’d     @ ï       (S—Iat¦  M§  
Á.‘’d     @ ğ       (S—IaX§  §§  
/‘’d     @ ñ       (SIa²§  ›©  
A/
 
 á	d     @ ò       (SIa¦©  º©  
/’“d       @ ó       (SIaÄ©   ª  
Á/’“d  
   @ ô       (SIaª  ìª  
0’“d     @ õ       (SIa÷ª  ¢¬  
A0’“d     @ ö       (SIa­¬  :­  
0’“d     @ ÷       (SIaE­  “­  
Á0
 
 á	d     @ ø       (S‘Ia­  Š®  
1“”d     @ ù       (S‘Ia•®  W¹  
A1“”d     @ ú       (S‘Iab¹  ±º  
1“”d     @ û       (S‘Ia¼º  K»  
Á1“”d     @ ü       (S‘IaV»  ¼À  
2“”d     @ ı       (SIaÇÀ  JÁ  
A2
 
 á	d     @ ş       (S’IaUÁ  yÂ  
2”•d     @ ÿ       (S’Ia„Â  ~Æ  
Á2”•d     @        (S’Ia‰Æ  îÇ  
3”•d     @       (S’IaúÇ  6É  
A3”•d     @       (S’IaAÉ  ¨á  
3”•d     @       (SIa³á  Jã  
Á3
 
 á	d     @       (S“IaUã  €ã  
4•–d     @       (SIa‹ã  Hä  äe       ¹ÈÅÈ @ @ €  
A4•–d     @       (S“IaSä  ¸ä  
4•–d     @       (SIaÃä  )å  
Á4
 
 á	d     @ 	      (S”Ia4å  ~æ  
5–—d     @ 
      (S”Ia‰æ  5ç  
A5–—d     @       (S”Ia@ç  Øç  
5–—d     @       (S”Iaãç  ë  
Á5–—d     @       (SIaë  ·ì  äd       Ï×µØ @ €
6
 
 á	d     @       (SIaÂì  ¯í  
A6—d     @       (S‘Iaºí  åí  
6—d     @       (S‘Iağí  jğ  
Á6—d     @       (S‘Iauğ   ò  
7—d     @       (S‘Iaò  Şò  
A7—d     @       (S‘Iaéò  „ö  
7
 
 á	d     @       (SIaö  tı  
Á7‘d     @       (SIaı  =ş  äd       ıûºü @ # 
8‘d     @       (S”IaHş  Åş  •d       Ÿı»ı @ )€
A8‘d     @       (S”IaĞş  e  $•g       Íşäş @¾ÿÚ€ @ )    
8
 
 á	d     @       (SIap  Â  
Á8‘’d       @       (S“IaÍ  7 
9‘’d     @       (S“IaB ÿ 
A9‘’d     @        (S“Ia
 ´ 
9‘’d     @ !      (S“Ia¾ 4 
Á9‘’d  
   @ "      (S“Ia? « 
:
 
 á	d     @ #      (SIa¶ : 
A:’“d     @ $      (SIaE ” äd       ùŒŸ
 @   
:’“d       @ %      (S”IaŸ Ü QbªğPñ   Qh  ’“d     @ '      (S”Iaç * 
Á:’“d     @ (      (S”Ia5 ø 
;
 
 á	d     @ )      (SIa ¾ 
A;“”d     @ *      (S•IaÉ ş 
;“”d     @ +      (S•Ia	 B 
Á;“”d     @ ,      (S•IaM ^ 
<“”d     @ -      (S•Iai ƒ 
A<“”d       @ .      (S•Ia ¯ 
<
 
 á	d       @ /      (SIaº $ 
Á<”•d     @ 0      (S–Ia/ * 
=”•d     @ 1      (S–Ia5 w 
A=”•d     @ 2      (S–Ia‚ ¶ 
=”•d     @ 3      (S–IaÁ à- 
Á=”•d     @ 4      (SIaë- |. äd       ÕÜéÜ @  
>
 
 á	d       @ 5      (SIa‡. ¿. 
A>—d       @ 7      (S‘IaÊ. 0 
>—d       @ 8      (S‘Ia'0 x0 
Á>—d     @ 9      (S‘Iaƒ0 İ1 
?—d     @ :      (S‘Iaè1 ¢2 
A?—d     @ ;      (S‘Ia­2 3 
?
 
 á	d     @ <      (SŒ¨`Ğ   (L`   <Rc   Äã‚        â×
$¡a¤ÿ ¤ÿ 
Á?`şÿÿÿDaDf ôh ,Q N³'   __REACT_DEVTOOLS_GLOBAL_HOOK__  QdGç 
   isDisabled  Qeîğıı   supportsFiber   QcbÖ ·   inject  (SPc      Ej.bf   aØ3 +4 

,‘d     @ >      (S–Pc      Ej.Ne   a74 f4 
Á
 á	d     @ ?       Rc   J €        
$á`¤ÿ Kd    ,   U   ¹     D}             „ û sšª&ú(ú—&ú(ú—ª'ÿú&ø(ø&ùYùø
  ûÿ   ûÿ  ‹&ùƒù&ú§%úùùª  ˜c      P @ ’d    @@=      (S–Ia…4 6 
 
 ’d     @ @      (SIa6 J6 
@–’d     @ A      (S—IaU6 Ú6 
€–’d     @ B      (S—Iaå6 Q9 
À–
 á	d     @ C      (S—Ia\9 1< 
–“d     @ D      (S—Ia<< p< 
A–“d     @ E      (S—Ia{< °< 

 “d     @ F      (SIa»< p= 
Á—“d     @ G      (SIa{= ? 
—“d     @ H      (SIa%? u? 
A—
 á	d     @ I      (SIa€? P@ 
—”d     @ J      (SIa[@ cA 
Á—”d     @ K      (SIanA ®A 

 ”d     @ L      (SIaºA æC 
A”d     @ M      (S‘IañC oD 
”d     @ N      (S‘IazD ĞD 
Á
 á	d     @ O      (S‘IaÛD E 
•d     @ P      (S‘IaE ŞE 
A•d     @ Q      (S‘IaéE jF 

 •d     @ R      (SIauF KG 
Á‘•d     @ S      (SIaVG “H ,äi       Çà @Ğé @õ„‘ @ (7  
‘
 á	d     @ T      (S’IaH >I 
A‘—d     @ X      (S’IaII ÆI 

 —d     @ Y      ±(S
ÁağI ]J •’—d	 	    @ Z      ¤a      QcÖHlB   onError C(S”Pd   
   li.onError  aJ J 
,á)’
 á	d     @ [      —Q@Ú×ø   window  
ñ
A@Qn
B2   __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED  QcÖèH¢   assign  (S”
Á
a¼K ÎK “
 d     @ \      (S
aÚK øK –”d     @ ]      (S•
AaL L —”d       @ ^      QdrS&æ	   Scheduler   $QgµŞ)   unstable_cancelCallback Qd†í|Ô   unstable_now(QhÃÓ   unstable_scheduleCallback    Qf6ç   unstable_shouldYield$QgŞ£Ğş   unstable_requestPaint   $QgÚ5ÆÒ   unstable_runWithPriority,Qi2É    unstable_getCurrentPriorityLevel(Qh¢qG   unstable_ImmediatePriority  ,Qi–[TØ   unstable_UserBlockingPriority   $Qgz™Üj   unstable_NormalPriority  Qf>–Ï   unstable_LowPriority$Qgbøb   unstable_IdlePriority   iQ‘ª|õ[  ^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$ É
¡Q1¶á¶²„   children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning styleQcÒÒÑ   split    ¢ÓQcË×   forEach (SL¨`R   ]K`    DmH             <&û&ù&÷&ö&ô&ó%ù'ø'øõeùø 0ûª ,Rc   Äã‚        I`şÿÿÿDaâŸ &  
 ˜b       4  
 á	d    @@_      ù`   L`   `   M`   QezşÙI   acceptCharset   QenàÕ€   accept-charset  `   M`   QP28>	   className   Q@Â#¥Y   class   `   M`   Qc:t˜   htmlFor QbäËÂ   for `   M`   QdÂÆ&	   httpEquiv   Qdö+µı
   http-equiv  (SX”`h   ]K`    DpP            * &û <&ú&ø&ö&õ*&ô&ó&ò%ø'û÷eø÷0úûª  ,Rc   Äã‚        I`şÿÿÿDa¡ x¡ •–c        @    —d    @@`      `   M`   QeÒ2Iû   contentEditable Qd2ÀØ	   draggable   Qdº!R
   spellCheck  á(SX”`f   L`   
!K`    DpH             <&û&ù&÷&ö(  &õXõ&õ&ô&ó%ù'øeùø0ûª   ,Rc   Äã‚        I`şÿÿÿDa¢ d¢ •–c       @    —d    @@a      `   M`   Qdz,ş½   autoReverse (QhV~®   externalResourcesRequired   QPJâ	   focusable   Qe*šÚC   preserveAlpha   (SL”`T   ]K`    DmH             <&û&ù&÷&ö&ô&ó%ù'ø'øõeùø 0ûª,Rc   Äã‚        I`şÿÿÿDa£ Z£ •–b       4  —d    @@b      äQÊ8'×Õ   allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope   (SX”`f   L`   ’K`    DpH             <&û&ù&÷&ö(  &õXõ&õ&ô&ó%ù'øeùø0ûª   ,Rc   Äã‚        I`şÿÿÿDaD¥ ¤¥ •–c       @    —d    @@c      `   M`   Q@şHÜL   checked Qcæç&   multipleQc:imœ   muted   QcJì   selected(SL”`T   ]K`    DmH             <&û&ù&÷&ö&ô&ó%ù'ø'øõeùø 0ûª,Rc   Äã‚        I`şÿÿÿDa¦ ^¦ •–b       4  —d    @@d      `   M`   Qc–éí•   capture Qc®ºˆı   download(SL”`T   ]K`    DmH             <&û&ù&÷&ö&ô&ó%ù'ø'øõeùø 0ûª,Rc   Äã‚        I`şÿÿÿDa°¦ ò¦ •–b       4  —d    @@e      `   M`   QbÚ|²£   colsQbV·t   rows òÙQbvÅaó   span(SL”`T   ]K`    DmH             <&û&ù&÷&ö&ô&ó%ù'ø'øõeùø 0ûª,Rc   Äã‚        I`şÿÿÿDaR§ ”§ •–b       4  —d    @@f      `   M`   QcR²³Ë   rowSpan QcˆKí   start   (SX”`f   L`   ’K`    DpH             <&û&ù&÷&ö(  &õXõ&õ&ô&ó%ù'øeùø0ûª   ,Rc   Äã‚        I`şÿÿÿDaà§ >¨ •–c       @    —d    @@g      Qd”í   [\-:]([a-z])(S4”`$   L`   
¡2K`    Dg            * &ú(ú &ûXûúª,Rc   Äã‚        
Á`şÿÿÿ•a†¨ Â¨ 
 ˜b       @ 
 á	d    @@h      EQv1qÈ7  accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height (Sh¨`ˆ   L`   Qcû:   replace K`    DtP            (  &ú =&ø >&÷Zúø÷&û <&ú&ø&ö&õ&ó&ò%ø'û÷'ôeø÷0úûª  ,Rc   Äã‚        I`şÿÿÿDan± à± –—c       @    d    @@i      TQsô]£H   xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type(Sh‘`Š   L`   
4(QhÒ jÉ   http://www.w3.org/1999/xlinkK`    DtP            (  &ú =&ø >&÷Zúø÷&û <&ú&ø&ö&õ&ó&ò%ø'û÷'ôeø÷0úûª ,Rc   Äã‚        I`şÿÿÿDa°² T³ –—c       @    d    @@j      ù`   M`   QcBËğ)   xml:baseQc2ü¼|   xml:langQdâwu“	   xml:space   (Sh‘`Š   L`   ’0Qj¢>×Ë$   http://www.w3.org/XML/1998/namespaceK`    DtP            (  &ú =&ø >&÷Zúø÷&û <&ú&ø&ö&õ&ó&ò%ø'û÷'ôeø÷0úûª ,Rc   Äã‚        I`şÿÿÿDaÀ³ t´ –—c       @    d    @@k      “`   M`   QcòìG#   tabIndexQd>µÂb   crossOrigin (SX‘`f   L`   
!K`    DpH             <&û&ù&÷&ö(  &õXõ&õ&ô&ó%ù'øeùø0ûª   ,Rc   Äã‚        I`şÿÿÿDaÎ´ ,µ –—c       @    d    @@l      Qdêmx	   xlinkHref   Qd2tÕ
   xlink:href  
4Á“`   M`   Qbnº\W   src  bÜQ@fÑ6ˆ   action  QdV#e
   formAction  (SX‘`f   L`   ”K`    DpH             <&û&ù&÷&ö(  &õXõ&õ&ô&ó%ù'øeùø0ûª   ,Rc   Äã‚        I`şÿÿÿDaB¶  ¶ 
 ˜c       @    
 á	d    @@m      $QgZŸxC   ReactCurrentDispatcher  ¤a      ]F$Qgæ²ø   ReactCurrentBatchConfig ’a      QcNs’˜   suspenseFQdBçµE   ^(.*)[\\\/] ‰
0QeÖ^k¦   react.element   Qdªf#‘   react.portalQeFv!z   react.fragment   Qfr Õ   react.strict_mode   Qe‚>Ú   react.profiler  Qeâ´øN   react.provider  Qe‚¤    react.context   $Qg!ú   react.concurrent_mode    Qfƒî…   react.forward_ref   Qe’   react.suspense   QfæAŸ   react.suspense_list QdÚ–ê
   react.memo  QdŞ<gr
   react.lazy  Qd.§zÄ   react.block QcŠĞ?—   iterator(SH¨`H   L`   4Rc   Äã‚        rÕ`$   I`şÿÿÿDaä½ ¿ 
 Q@úUKS   MSApp   $Qg¢ääb   execUnsafeLocalFunction (SIa>_ …_ äd       î¾ƒ¿ @ *€I
4q5
 á	d     @ o      K`    Dl            „ û% s™&ú(ú˜ ‹ª  “˜b      P ”d    @@n      (SIa‘_ ´` I”d     @ q      (S–
ÁaÁ` .a —”d     @ r      ,¤a      Qd*³‰Q   animationendC QfâÙ€W   animationiteration  CQeª@‹b   animationstart  CQeîê±Ö   transitionend   CQdìF~	   Animation   Qd¦\OU   AnimationEnd
4A; Qf6Š+±   AnimationIteration  
4¡;Qe‚şe   AnimationStart  
4!<QdbBDc
   Transition  Qe–7óÃ   TransitionEnd   
4‘<
±yQeºè²%   AnimationEvent  QP6Æ©ò	   animation   Qe²yŸ[   TransitionEvent QP^Sÿ8
   transition  àQqnsÎMÓ   abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange seeked seeking stalled suspend timeupdate volumechange waiting éi(S
a„d e ’
 
 á	d     @ s      QAVpê™  mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput close cancel copy cut paste click change contextmenu reset submit |Q}šÆq\m   focus blur dragenter dragleave mouseover mouseout pointerover pointerout gotpointercapture lostpointercapture   ù`   ĞL`d   Qcn+ÅØ   abort   
8A`    Qdf;°   animationEnd`     QfÎ\ÁA   animationIteration  `    Qe¢ï³   animationStart  Qc^œŞ\   canplay Qc*ş Ê   canPlay QešSyn   canplaythrough  Qe2àà™   canPlayThrough  QeŞ)Ùï   durationchange  Qeşµ(   durationChange  Qcò§§^   emptied 
8AQdıØy	   encrypted   
8‘Qc2…zÒ   ended   
8ñQ@R%–   error   
8A Qf³(¢   gotpointercapture    Qf
Çõ   gotPointerCapture   QbN$:f   load
8‘QdšúsP
   loadeddata  Qd~XrÒ
   loadedData  Qe†ı9Ê   loadedmetadata  Qe¸Í&   loadedMetadata  Qd9×´	   loadstart   Qdú]ß”	   loadStart    QfBğ_z   lostpointercapture   Qf.^i   lostPointerCapture  Qc*i   playing 
81Qc–4   progress
8QcÒo3:   seeking 
8ÑQc¦h|   stalled 
8!QcVy¥y   suspend 
8qQdF–¹~
   timeupdate  Qd"æò
   timeUpdate  `    QeòïÆm   transitionEnd   Qc¶Ğ   waiting 
8ñ9QÑŞªO*  blur blur cancel cancel click click close close contextmenu contextMenu copy copy cut cut auxclick auxClick dblclick doubleClick dragend dragEnd dragstart dragStart drop drop focus focus input input invalid invalid keydown keyDown keypress keyPress keyup keyUp mousedown mouseDown mouseup mouseUp paste paste pause pause play play pointercancel pointerCancel pointerdown pointerDown pointerup pointerUp ratechange rateChange reset reset seeked seeked submit submit touchcancel touchCancel touchend touchEnd touchstart touchStart volumechange volumeChange  !QqjşÏš  drag drag dragenter dragEnter dragexit dragExit dragleave dragLeave dragover dragOver mousemove mouseMove mouseout mouseOut mouseover mouseOver pointermove pointerMove pointerout pointerOut pointerover pointerOver scroll scroll toggle toggle touchmove touchMove wheel wheel   (ST¨``   L`   UUK`    Do             &û(  iûš$ k&ù(ù&ú%û*&øZúùø%ûL	&ûŠ( ª  ,Rc   Äã‚        I`şÿÿÿDa Ú  Û 
 ˜c
       À€€ 
 á	d    @@t      `Qv¶y÷—R   change selectionchange textInput compositionstart compositionend compositionupdate  ]¤aª      $Qgvˆ–†   animationIterationCount G QfN†Y   borderImageOutset   GQe¢A‚Ü   borderImageSliceGQeàß   borderImageWidthGQcú-ô™   boxFlex GQdrê.X   boxFlexGroupGQe¶A7   boxOrdinalGroup GQd2L—a   columnCount GQ@Kù   columns GQbşÏ‹q   flexGQcò‚p   flexGrowGQdÒ¶ü\   flexPositiveGQdr
   flexShrink  GQdRö'_   flexNegativeGQd’‚)”	   flexOrder   GQcFÅw   gridAreaGQc2sm   gridRow GQd2á
   gridRowEnd  GQdŸ#   gridRowSpan GQdúq‘   gridRowStartGQdÆ·WH
   gridColumn  GQeZV!Ì   gridColumnEnd   GQeNì¹9   gridColumnSpan  GQe­ÁL   gridColumnStart GQd¾Şü5
   fontWeight  GQdNé¶o	   lineClamp   GQPŞ›ì
   lineHeight  GQ@ÖÅ?   opacity GQcÒ#Æ   order   GQcéb1   orphans GQc––Á   tabSize GQc¦Ù    widows  GQ@zèÇ#   zIndex  GQb6srn   zoomGQdFÈ×f   fillOpacity GQd
.)   floodOpacityGQdTİ&   stopOpacity GQe>Eß(   strokeDasharray GQe~ƒ@   strokeDashoffsetGQe·àº   strokeMiterlimitGQe>—ö   strokeOpacity   GQd~CYI   strokeWidth Gù`   M`   
QbB>	#   ms  
!	QbÕ•c   O   M(SH¨`L   L`   4Rc   Äã‚        rÕ`$   I`şÿÿÿDa\á â 
 
,?(S|•`´   L`   QcÖŒ©ù   charAt  
¡2Qd¶€5_	   substring   K`    Dy(            &ø(ø  &ù&÷Yùø÷&ù(ù&úXúù4&û&ù(ù	&ú&øYúùø4û& ÿÿo &û ÿÿo &ù*ù0ûª,Rc   Äã‚        I`şÿÿÿDaŠá â 
<ñ˜d       P ¼à!Ğ 
 á	d    @@v      K`    Dl             „ û% ûÿp  &ù(ù &ú &øYúùøª’“b        ”d    @@u      ¤a      Qc{ ä   menuitemG„•a>      Qb†h_c   areaGQbf?Æ   baseGQbšõ’   br  GQb
 Ù   col GQcFë©   embed   GQbŠßEV   hr  GQbj Œø   img G1GQcÊ!Õ‰   keygen  GQb#Ü   linkGyGQcN„ö   param   GeGQ@îúq¡   track   GQb63àš   wbr G BsQb²)¢ê   /$  Qbİ¤£   $?  Qbö0ƒÍ   $!  Qd6lòº
   setTimeout  Qd>€nK   clearTimeoutQbÂx—   MathQcÆVõ   random  ±
3$Qg~ÛS¡   __reactInternalInstance$$Qgñu2   __reactEventHandlers$    QfZIJ†   __reactContainere$  4•a      Qe
°ëN   preventDefault  CQe¢^ç   stopPropagation CQcfÜ>n   persist CQdÆDÌü   isPersistentCQdªvğ
   destructor  C(S5a      
Á	•a      
<Qaôr  s 
 
 á	d       @ w      (S”•a      –•a      —
<Áa¹s St “‘’d       @ x      “(S”Pd   	   M.persist   adt |t 
<1‘’d       @ y      ”
<(SPd      M.destructora t ƒu 
<á‘’d       @ z      —T¤a&      F•FQeÛ£   currentTarget   CQdâN¬
   eventPhase  FQcFj0   bubbles FQdr)Ï
   cancelable  FQd®ÌM«	   timeStamp   CQe¦U7ö   defaultPreventedFQdÆ6	   isTrusted   F(S–5a      
“a      “a      Qd&¿z	   Interface   “a      •
< a¿u Îu –
 
 á	d       @ {      –(S“a      ”“a      •“a      
<‘$Pd   
   .timeStamp  av 2v 
<‘!—d     @ |      “’(S°¨`  $L`   8Rc   Äá‚       
$¡a¤ÿ şÿÿÿI`şÿÿÿPc      R.extendaÔì œî —(S‘Iaxv šv  â×
<a+d    
   @ ~      (S$”`   ]K`    Dc             ª,Rc   Äã‚         
$á`şÿÿÿa^í fí —Á
 á	d      @@      Y
<‘$Qc~0ıš   extend  K`    Dq@            „ ù &û%&ú&÷(÷ -ú%úeúû &ú ùÿ*  &ø(û&ö^øúö%ú-û
(û&ø%û-ø ùÿ*  &÷~&ö&õ(õ&õ'ô[÷ö-û&÷(÷-ûùl &ø]øû%ûª — ˜f      ,@ ° @ °    ’d    @@}      
<q/¤a      QbÆêæù   dataFa      
<±0Fù`    Md         6   @   Qej"cí   CompositionEventQd4|’   documentModeQd¾
1z	   TextEvent   yQdâ
¦   fromCharCode,a      QdÊ¨9¶   beforeInput a
      
a
      
Á4QeRÊ$ı   onBeforeInput   
5 Qf&&ì—   onBeforeInputCapture
q’`   M`   QeÎH6S   compositionend  Q@Âı¢   keypressQd~—2	   textInput   QcG/   paste   QenM›   compositionEnd  CQeÚÌ1T   compositionStartC QfB_HÇ   compositionUpdate   Ca
      ”a
      •QeÚ.–Ş   onCompositionEnd–$QgÕ¡<   onCompositionEndCapture —C@Qnò4   blur compositionend keydown keypress keyup mousedown—
<A8¤a
      ”‘a
      • Qf²Ğ–ï   onCompositionStart  –(Qh+{Ö   onCompositionStartCapture   —CDQor¾ÀN6   blur compositionstart keydown keypress keyup mousedown  
<±8‘a
      ”‘a
      • Qf¦znd   onCompositionUpdate –(Qhb–ä:   onCompositionUpdateCapture  —CDQo`O7   blur compositionupdate keydown keypress keyup mousedown 
<!9‘a
      
AC
ÑC”(S5a      QbFÿèX   Wj  —a      •au{ ~ •
 
 á	d     @ €      •„¤a>       ÙGQbS®   dateGQcji«   datetimeGQešİeå   datetime-local  GQcñ2ä   email   GGÁGQcÎÔ–÷   passwordGQc:AN   range   GQ@† –   search  GQbªÀ[B   tel GQb.˜WÅ   textGQbó=Ë   timeGQbvÓqÛ   url GõG“a      Q@â3   change  C“a
      
“a
      
Á4Qcê"Oˆ   onChange
5QeîíGf   onChangeCapture 
qCHQpêÆx$;   blur change click focus input keydown keyup selectionchange 
@q
1$¤a      
AC$Qg¦Xş   _isInputEventSupported  C
ÑC
@(S5a      Qb:Äí   Xj  “a      aë } 
 
 á	d     @       ¤a
      Qbö;Ä   viewFQcFÀ   detail  F,—a      Qb~÷8”   Alt QcŠ˜f‡   altKey  Qcâ8A’   Control Qc.ö   ctrlKey QbN:9   MetaQcÆÊt   metaKey QcÂ„wÓ   Shift   Qcª/XH   shiftKeyŒ—aB      QcÆÑ,   screenX FQcªe   screenY FQcŞ³'9   clientX FQcnïá   clientY FQcªZ!/   pageX   FQcYB   pageY   F
@ñF
@!F
@QF
@FQe*…)Ø   getModifierStateCQ@Êµ*˜   button  FQcZşõµ   buttons FQeK;   relatedTarget   CQdÚ·‹	   movementX   CQdv+ME	   movementY   C
@(S5a      
#–a      –a      
<q/–a      
@‘aÎ‚ #ƒ ’
 
 á	d     @ ‚      ’(S•–a      —–a      –a      ‘Pd   
   .movementX  a6ƒ ­ƒ 
@“”d     @ ƒ      •(S5a      
#—a      —a      
<q/Pd   
   .movementY  aÀƒ 8„ 
@a
 
 á	d     @ „      “\¤a*      Qd²ß’Ù	   pointerId   FQ@ŠkÛä   width   FQ@Z;‚   height  FQc’®ï¾   pressureF Qf†ƒv   tangentialPressure  FQc†dĞ   tiltX   FQcòöN   tiltY   FQc®ÇÕ   twist   FQdF”·î   pointerType FQdÇ|t	   isPrimary   F,–a      Qd~™™
   mouseEnter  –a
      
¡QdV†SI   onMouseEnter
qù`   M`   Q@¾í<   mouseoutQPş°	   mouseover   Qd~œJ
   mouseLeave  –a
      —Qd¸÷p   onMouseLeave‘`   M`   
@(
@Ñ(Qdì×ı   pointerEnter–a
      —Qeb÷Ÿ—   onPointerEnter  ‘`   M`   Qd(à”
   pointerout  QdZû†   pointerover QdbQo¬   pointerLeave–a
      —Qen[•   onPointerLeave  ‘`   M`   
@,
@á,–a
      
AC
ÑC(S5a      Qbö|Ú   Yj  ‘a      —ab† 9‹ —
 
 á	d     @ …      Qbòx3%   is  ¤a      Q@2&¤   select  C•a
      
•a
      
Á4Qcjîüî   onSelect
5Qe›è¼   onSelectCapture 
qC\QuªS^œN   blur contextmenu dragend focus keydown keyup mousedown mouseup selectionchange  
@±1•a
      
AC
ÑC(S5a      Qb~ÿÀ   ak  –a      ”aÎŒ Ø ”
 
 á	d     @ †      $¤a      QeÒV
>   animationName   FQdá”   elapsedTime FQeâEÂ±   pseudoElement   F’a      QeBÜÂª   clipboardData   C(S•–a      
–a      —–a      
<q/–a      —
@a9aC † •‘d     @ ‡      •’a      
@‘Fl’a2      Qb–7u¢   Esc QcÊu¹Ú   Escape  Qcšü•*   Spacebar ¢ÓQbŠ¶¼Q   LeftQd2Â€	   ArrowLeft   QbBn   Up  QcvÎıI   ArrowUp QcÚ†›{   Right   Qd¦²y
   ArrowRight  QbòM†ê   DownQdj4šû	   ArrowDown   Qb†m   Del QcÚu{+   Delete  Qbº":   Win QbÒsÑ€   OS  QbşxÓ   MenuQdêÙYZ   ContextMenu Qb.›    Apps
D¡Qcò+rÛ   Scroll  Qdæ‰4_
   ScrollLock  QeÎÅud   MozPrintableKey Qdâ¬   Unidentified1’b”          QdNîa	   Backspace   `   Qb>Ó9%   Tab `   Qc>ã/   Clear   `   Qc"ÉV   Enter   `    
@Ñ`"   
@¡`$   
@`&   QcnÍ2œ   Pause   `(   Qc6ó+   CapsLock`6   
@1>`@   —`B   Qc*²M   PageUp  `D   Qc‚ÿ·   PageDown`F   Qbö~¨z   End `H   Qb¶”5   Home`J   
@?`L   
@±?`N   
DP`P   
Dğ`Z   QcNä»   Insert  `\   
D‘`à   Qbªš%€   F1  `â   Qbv	˜·   F2  `ä   QbŒŞø   F3  `æ   Qbj:P   F4  `è   QbŞ Mƒ   F5  `ê   Qb^ÑŠ   F6  `ì   QbÎiÃg   F7  `î   Qb¢ç­¦   F8  `ğ   QbúV¹   F9  `ò   QbvÂ£ô   F10 `ô   QbLi¹   F11 `ö   Qbšÿ$“   F12 `   Qc‡°Å   NumLock `"  
D‘`À  
@A`    l¤a2      Qb‚¸7Ù   key CQcÚ¼   locationF
@ñF
@!F
@QF
@FQc}­   repeat  FåF
@CQcêmÈ^   charCodeCQc6ëÔ   keyCode CQc»2   which   C(S5a      
#Pd      .extend.key a/’ “ 
DÑ
 
 á	d     @ ˆ      –(S“”a      •”a      ”a      
<q/Pd   	   .charCode   aƒ“ ©“ 
D±—d     @ ‰      “(S5a      
#•a      ‘•a      ’Pc      .keyCodeaº“ õ“ 
D
 
 á	d     @ Š      —(S”•a      –•a      Pd      extend.whicha” Z” 
DQ‘d     @ ‹      “¤a      Qd".mH   dataTransferFL”a"      Qcªzû›   touches FQe"5ú   targetTouches   FQe®Ğ~Ã   changedTouches  F
@QF
@F
@ñF
@!F
@C$”a      
Q+F
@A8F
@¡8F,¤a      Qcn®™ó   deltaX  CQcÚ8Ï¸   deltaY  CQcªS:F   deltaZ  FQdnqª¨	   deltaMode   F(S5a      
$—a      —a      
<q/Pc      .deltaX am• °• 
D±
 
 á	d     @ Œ      “(S–—a      —a      ‘—a      ’Pc      .deltaY aÀ• #– 
D ”•d     @       –¤a
      
AC
ÑC(S5a      QbÆÎÿh   lk  “a      ‘ai– š ‘
 
 á	d     @       (Sl¨`   L`
   ±İ
3Qb~HªÆ   callK`    Du             #˜  &û&úe&ù]úù&ú]ûú¨&ú(ú&ú(ú
&ú(ú&ûYûú #&û\ûª   ,Rc   Äã‚        I`şÿÿÿDaF4 Ğ4 •˜d       @ P @ –d    @@      „Q²ÅLw   ResponderEventPlugin SimpleEventPlugin EnterLeaveEventPlugin ChangeEventPlugin SelectEventPlugin BeforeInputEventPlugin (S8—`(   ]K`    Dh              %  % !% "ª  ,Rc   Äã‚        I`şÿÿÿDaò5  6 •Á–d    @@      4¤a       Qf’—z   SimpleEventPlugin   C$Qg6ÿêÔ   EnterLeaveEventPlugin   C QfNó>   ChangeEventPlugin   C QfÚ;	C   SelectEventPlugin   C$Qgv`g	   BeforeInputEventPlugin  C
DÑ0
DQ1
Dá1
Da2
Dá2–a      ]C”–a      ”H(S
.a*œ .œ I
 
 á	d       @ ‘      (S•
A/abœ tœ I—d       @ ’      ¤a      ”FQdB÷+é	   Component   QbJgl2   refs,’a      QdJùÖ’	   isMounted   CQe¶ƒ?   enqueueSetState C Qf^hÓ˜   enqueueReplaceState C Qf
€bq   enqueueForceUpdate  C(S•Pd      Mc.isMountedaşœ / 
Dq7—d     @ “      “(S•5a      
Á1”a      
DÑ7aH Ø —
 
 á	d     @ ”      —(S”a      •”a      –
DA8aõ  “‘d     @ •      “(S’”a      •”a      –
DÁ8aª 5Ÿ ”‘d     @ –      ”İQcFğ>   isArray ¤a      ]C–a      —C–a      —C–a      —`    |–a:      Qdš‰•   readContext CQd~e    useCallback CQdŞİRÃ
   useContext  CQd†	×	   useEffect   C Qf–~™ÿ   useImperativeHandle CQe&~}J   useLayoutEffect CQc†æ   useMemo CQd–™®ç
   useReducer  CQcÊeW   useRef  CQcJZ y   useStateCQeŠ†8¬   useDebugValue   CQdîˆÛû   useResponderCQeÎKËj   useDeferredValueCQe&7T^   useTransition   C
H‘
Hñ
HQ
H±
H
H‘
H
HQ
H±
H
HQ
HÁ
H!
H‘|¤a:      
H‘C
HñC
HQC
H±C
HC
H‘C
HC
HQC
H±C
HC
HQC
HÁC
H!C
H‘C(S5a      
6–a      
Ha!¡ v¡ ‘
 
 á	d     @ —      (S•–a      —–a      
H‘a¡ ¨¡ ”’“d     @ ˜      (S•Pd   
   dj.useMemo  a¹¡ ¢ 
H’“d     @ ™      (S5a      
6Pd      .useReducer a¢ ç¢ 
HQ’“d     @ š      (S–Pd   	   dj.useRef   a÷¢ -£ 
H±
 
 á	d     @ ›      (S—a      —a      
H!at£  ¤ äd       ŸÇïÇ @ ( —“”d     @ œ      (S5a      
6’a      –
H‘a¤ ]¤ ”
 
 á	d     @       |¤a:      
H‘C
HñC
HQC
H±C
HC
H‘C
HC
HQC
H±C
HC
HQC
HÁC
H!C
H‘C(SPd      ej.useState aø¤ 
¥ ‘
 
 á	d     @ Ÿ      (S5a      
A6’a      
H!aE¥ Ò¥ äd       ñÊÁË @ ( •—d     @        (S’a      “’a      ”
H‘aé¥ /¦ 
 
 á	d     @ ¢      |¤a:      
H‘C
HñC
HQC
H±C
HC
H‘C
HC
HQC
H±C
HC
HQC
HÁC
H!C
H‘C(SPd      fj.useState aÊ¦ Ü¦ •
 
 á	d     @ £      (S5a      
6–a      
H!a§ ¤§ äd       ÃÎ“Ï @ ( ‘“”d     @ ¤      (S–a      —–a      
H‘a»§  ¨ ”
 
 á	d     @ ¦       Qf*¼”‚   ReactCurrentOwner   ¤a
      Qd–É3
   dehydrated  FQdR¶r	   retryTime   `    (S“
A8ag¨ …© •–d     @ §      (S“
8a•© š© ‘•–d     @ ¨      (S“
Á8aª© b¯ ’•–d     @ ©      (S“
9ar¯ ”¯ “•–d     @ ª      ñIQbö|f   ceil(S
a± ² —
 
 á	d     @ «      (S–
Aa.² -Ä ’‘d     @ ¬      (S–
aMÄ nÄ “‘d     @ ­      (S–Pd   	   ef.render   a‹Ä ²Ä I‘d     @ ®      Qcj!ú   render  (SPd   
   ef.unmount  aĞÄ %Å äd       •Š£Š @  I‘d       @ ¯      Qcöm^¿   unmount (S–
Aa5Å pÅ –‘d     @ ±      (S
a€Å ¢Å 
 
 á	d     @ ²      (S—
Áa²Å ñÅ “‘’d     @ ³      (S—

aıÅ ŒÇ ”‘’d     @ ´      (S<¨`4   ]K`    Di    (         % .% /% 0% 1ª,Rc   Äã‚        I`şÿÿÿDa, h ‘Á’d    @@µ      (S—5a      Qb2«…Y   mk  —a      —a      Qcqpl   Events  Pc      .currentaÁÇ È I‘’d     @ ¶      (S
H4a$È FÈ I
 
 á	d       @ ·      (S‘IaOÈ ‹È I“”d     @ ¸      ¤a      
HA5Cù`   <Ll                                                   •a      ]H(S‘’a·È ÄÈ I“”d     @ ¹      –(S|¨`²   (L`   4Rc   Äã‚        â×`¤ÿ I`şÿÿÿDaØ‘ J• “$QgŠ¾   findFiberByHostInstance l•a2       Qfú÷gg   overrideHookState   FQešP3-   overrideProps   F Qf
©L   setSuspenseHandler  FQeæzìU   scheduleUpdate  F Qf¾è¯r   currentDispatcherRefC$Qg’÷
Ç   findHostInstanceByFiber C
HA>C(Qh’0	e   findHostInstancesForRefresh FQe+ÌÖ   scheduleRefresh FQdú‚ß=   scheduleRootF Qfê‰¿e   setRefreshHandler   FQe’LïØ   getCurrentFiber F
4a*
L‘(S5a      
Á	—a      
LaÇÉ õÉ ’
Hq=
 á	d     @ »      ’(S–—a      —a      ‘
HA>aÊ -Ê •“”d     @ ¼      K`    Dy8            „ û(  ûÿ  &ú ûÿ*  &ù~&ø})&ö ûÿ?  &õ(õ/ö /ö/ö	'÷[ùø&ù]úùª “˜d      Ì€€   ”d    @@º      ,¤a      •CQdŠÍ0l
   bundleType  `    QcîÁ*-   version QcªR   16.13.1  Qf†­.   rendererPackageName QdbÜ(·	   react-dom   •Qd†_ˆ¹   createPortal(S5a      Qbòº   I   Pd      .findDOMNodeadË KÌ I
 ”d     @ ½      QdFä{"   findDOMNode (SPd      I.flushSync a`Ì ÍÌ I’”d     @ ¾      Qd"mç	   flushSync   (SPd   	   I.hydrate   aàÌ Í I’”d     @ ¿      Qc–U€   hydrate (SPc      I.rendera1Í pÍ I’”d     @ À      (S‘a      
L¡‘a      $Qgve0o   unmountComponentAtNode  a’Í .Î äd      İ›¥œ@   –d       ú›£œ @   I’
 á	d     @ Á      
L‘$QgFy*j   unstable_batchedUpdates (S5a      ”’a      •$Qg¦Y3¯   unstable_createPortal   alÎ ½Î I
 —d     @ Ä      
L(S‘’a   %   
L¡’a   $   0Qjº^Ù;#   unstable_renderSubtreeIntoContainer aìÎ hÏ I“—d     @ Å      
L
Lá
L‘K`    D‘—X            „  Ù% &û		

	
  !! ""!##"$$#%%$&&%''&(('))(**)&ú+*&ù,++-,,.--/..0//100211322433544655766877988:99;::<;;=<<>==?>>@??A@@BAACBBDCCEDDFE&øGFEHGFIHGJIHKJILKJMLKNMLONMPONQPORQPSRQTSRUTSVUTWVUXWVYXWZYX[ZY\[Z]\[^]\_^]`_^a`_ba`cbadcbedcfedgfehgfihgjihkjilkjmlknmlonmponqporqpsrqtsrutsvutwvuxwvyxwzyx{zy|{z}|{~}|~&÷€&ö€}‚~ƒ‚„ƒ€…„†…‚‡†ƒˆ‡„‰ˆ…Š‰†‹Š‡Œ‹ˆŒ‰Š‹Œ‘’‘“’”“•”‘–•’—–“˜—”™˜•š™–›š—œ›˜œ™šŸ› Ÿœ¡ ¢¡£¢Ÿ¤£ ¥¤¡¦¥¢§¦£¨§&õ©¨¤ª©¥«ª¦¬«§­¬¨®­©¯®&ô°¯&ó±°ª²±«³²¬´³­µ´®¶µ¯·¶°¸·±¹¸²º¹&ò»º³¼»´½¼µ¾½¶¿¾&ñÀ¿·ÁÀ&ğÂÁ&ïÃÂ¸ÄÃ¹ÅÄ&îÆÅºÇÆ»ÈÇ¼ÉÈ½ÊÉ¾ËÊ¿ÌËÀÍÌÁÎÍÂÏÎÃĞÏÄÑĞÅÒÑÆÓÒÇÔÓÈÕÔÉÖÕÊ×ÖËØ×ÌÙØÍÚÙÎÛÚÏÜÛĞİÜÑŞİÒßŞÓàßÔáàÕâáÖãâ×äãØåäÙæåÚçæÛèçÜéèİêéŞëêßìëàíìáîíâïîãğïäñğåòñæóòçôóèõôéöõê÷öëø÷ìùøíúù&íûúîüûïıüğşıñÿşò  ÿ ó  ô õ ö ÷ ø ù ú û 	ü 
	ı 
ş ÿ                     	  
                    !   "!  #"  $#  %$  &%  —   '  &Ø&× ã &Ö]×Ö&×]Ø×¨ (&      }) )&Ø *' /Øÿ+ %Ø    ! " #~ $|	 %~ &~ '~ ( ,
 s ™5  , &Ø (Øÿ- s ™  , &Ø (Øÿ- &Ø (Øÿ. sP )&Ø (Øÿ/ &Ø (Øÿ0  * + , - 1( . 2) / 3* 0 . 1 2 3&Ø (Øÿ/ &Ø (Øÿ4 &ì (ìÿ5 &ë (ìÿ6  4 (ìÿ7  5 (ìÿ8 &ê (ìÿ9  &é (ìÿ:"  6 (ìÿ;$ &è (ìÿ<& &ç (ìÿ=( &æ (ìÿ>*  7 (ìÿ?, &å (ìÿ@. &ä yA0   8 B1 &Ø (ØÿC3 &Ø (ØÿD5  9~ :~ ;~ < E&Ö (ÖÿF7 &× G&ÕY×ÖÕ9&× (×ÿH; &Ø I+&ÖYØ×Ö= zJ? &× (×ÿH@ &Ø K,&ÖYØ×ÖB zLD %&× (×ÿHE &Ø M-&ÖYØ×ÖG zNI %&× (×ÿHJ &Ø O.&ÖYØ×ÖL P&Ö (ÖÿFN &× G&ÕY×ÖÕP&× (×ÿHR &Ø Q/&ÖYØ×ÖT zRV %&× (×ÿHW &Ø S0&ÖYØ×ÖY zT[ %&× (×ÿH\ &Ø U1&ÖYØ×Ö^ zV` %&× (×ÿHa &Ø W2&ÖYØ×Öc zXe %&× (×ÿHf &Ø Y3&ÖYØ×Öh yZj  = [4 > \&Ö (ÖÿFk &× G&ÕY×ÖÕm&× (×ÿHo &Ø ]5&ÖYØ×Öq ^&Ö (ÖÿFs &× G&ÕY×ÖÕu&× (×ÿHw &Ø _6&ÖYØ×Öy z`{ %&× (×ÿH| &Ø a7&ÖYØ×Ö~ zb€ %&× (×ÿH &Ø c8&ÖYØ×Öƒ <&Ø&× d&Ö&Õ&Ô e&Ó f&Ò&Ñ%×e×Ö… -Øÿd‡  zg‰ %&× (×ÿHŠ &Ø h9&ÖYØ×ÖŒ&Ø (Øÿ/  ? ?&× (×ÿD &Ø i&ÖYØ×Ö —  ?&Ø }j’ )&× -Øÿi“ %× ?&× (×ÿD &Ø k&ÖYØ×Ö• —  ?&Ø }l— )&× -Øÿk˜ %× ymš   @ n› s š  n &Ø (ØÿoŸ &ã ˜$  n &× (×ÿoŸ &Ø p&ÖYØ×Ö¡ ‹	 Çê   A%ã ˜$  n &× (×ÿoŸ &Ø q&ÖYØ×Ö£ ‹	 Êê   B%ã ˜$  n &× (×ÿoŸ &Ø r&ÖYØ×Ö¥ ‹	 Ëê   C%ã ˜$  n &× (×ÿoŸ &Ø s&ÖYØ×Ö§ ‹	 Ìê   D%ã ˜$  n &× (×ÿoŸ &Ø t&ÖYØ×Ö© ‹	 Òê   E%ã ˜$  n &× (×ÿoŸ &Ø u&ÖYØ×Ö« ‹	 Íê   F%ã ˜$  n &× (×ÿoŸ &Ø v&ÖYØ×Ö­ ‹	 Îê   G%ã ˜$  n &× (×ÿoŸ &Ø w&ÖYØ×Ö¯ ‹	 Ïê   H%ã ˜$  n &× (×ÿoŸ &Ø x&ÖYØ×Ö± ‹	 Ğê   I%ã ˜$  n &× (×ÿoŸ &Ø y&ÖYØ×Ö³ ‹	 Ñê   J%ã ˜$  n &× (×ÿoŸ &Ø z&ÖYØ×Öµ ‹	 Øê   K%ã ˜$  n &× (×ÿoŸ &Ø {&ÖYØ×Ö· ‹	 Óê   L%ã ˜$  n &× (×ÿoŸ &Ø |&ÖYØ×Ö¹ ‹	 Ôê   M%ã ˜$  n &× (×ÿoŸ &Ø }&ÖYØ×Ö» ‹	 Ùê   N n› s š  n &Ø (Øÿ~½  O :&Ø €;&×]Ø×¿ Q < R }‚Á )&Ø ƒ&Ö „&Õ^úÖÕÂ /Øÿ…Ä  ƒ&Ö †&Õ^úÖÕÆ /Øÿ‡È  ƒ&Ö ˆ&Õ^úÖÕÊ /Øÿ‰Ì  Š&Ö ‹&Õ^úÖÕÎ /ØÿŒĞ %Ø S~ T~ U ) ˜¬  -Ò &× (×ÿ.Ô &Ø &ÖYØ×ÖÖ&Ø (ØÿØ  U &Ø , oØÚ ™E  S&Ø (Øÿ…Ü &Ø SØ S&Ø (Øÿ‡Ş &Ø SØ S&Ø (Øÿ‰à &Ø SØ ‘&Ø , oØâ ™  S&Ø (ØÿŒä &Ø ’SØ …&×]ù×æ V ‡&×]ù×è W ‰&×]ù×ê X Œ&×]ù×ì Y “&× (×ÿFî &Ø G&ÖYØ×Öğ Z ”ò s š  ”ô  ‹	  •ö &ØeØû ø [ \ –= ]|ú ^ _|û ` a b c •ö &ØeØû ü d •ö &ØeØû ş e |  f —&× (×ÿF&Ø G&Ö YØÿ×ÿÖÿ g ˜&× (×ÿF&Ø G&Ö YØÿ×ÿÖÿ h~ i •ö &Ø eØÿûÿ  	 j •ö &Ø eØÿûÿ   k z™%&×&Ø V 1×ÿØÿ&Ø W 1×ÿØÿ&Ø X 1×ÿØÿ.&Ø Y 1×ÿØÿ'×â š&Ö (ÖÿF&× G&Õ Y×ÿÖÿÕÿ&×&Ö ^øÿ×ÿÖÿ ›&Ö (ÖÿF&× G&Õ Y×ÿÖÿÕÿ&×&Ö ^øÿ×ÿÖÿ&Ö ^øÿâÿÖÿ œ>&Ø &Ö (ÖÿF&× G&Õ Y×ÿÖÿÕÿ &×&Ö ^Øÿ×ÿÖÿ"%æ l 6 m n }$) o zŸ%% p B1 &Ö (Öÿ &&× o&Õ Y×ÿÖÿÕÿ(&× (×ÿH*&Ø ¡?&Ö YØÿ×ÿÖÿ, *&Ø }¢.)&× }£/)&Ö ^Øÿ×ÿÖÿ0 q ¤ r ¥ s ¦ t § u v w ¨2s š  ¨4 ‹  x ©6s š  ©8 ‹  y ª:&Õ (Õÿ«<&Ö XÖÿÕÿ>&Ö (Öÿ¬@&×$&Õ Y×ÿÖÿÕÿB&× (×ÿ­D&Ø&Ö YØÿ×ÿÖÿF&á ®&Ø%á 4ØÿH z ¯&Ø%á 4ØÿI { °&Ø%á 4ØÿJ | } ~  *&Øi&× (×ÿCK&× }±M)&Ö ²@ /Öÿ³N ´A /ÖÿµP ¶B /Öÿ·Rh /Öÿ¸T ¹C /ÖÿºV ^Øÿ×ÿÖÿXi&Ø }»Z)&× ¼D /×ÿ½[ ¾E /×ÿ¿]%× -ØÿÀ_i&Ø ÁF -ØÿÂal&Øi&× ]Øÿ×ÿci&× (×ÿÂe&Ø }Ãg)&Ö YØÿ×ÿÖÿh €i&× (×ÿÂe&Ø }Äj)&Ö YØÿ×ÿÖÿk  zÅm% ‚ ) ˜  Æ&Ø ,  oØÿn ƒ&à ) ˜+  Ç&Ø -Ò  oØÿp š  -Ò &Ø (ØÿÇr&à ) ˜  È&Ø ,  oØÿt š %àP „ ) ˜.  ƒP ™% %à ˜ &Ø%à iØÿv š &Ø%à lØÿw … Éx&× (×ÿÊz&Ø &Ö YØÿ×ÿÖÿ| † }Ë~&Ø }Ì&× Í&Õ (ÕÿF€&Ö G&Ô YÖÿÕÿÔÿ‚ /×ÿÎ„%× /ØÿÏ† }Ğˆ&× Ñ&Õ (ÕÿF‰&Ö G&Ô YÖÿÕÿÔÿ‹ /×ÿÎ%× /ØÿÒ }Ó‘&× Ô&Õ (ÕÿF’&Ö G&Ô YÖÿÕÿÔÿ” /×ÿÎ–%× /ØÿÕ˜%Ø ‡ ˆ ‰ }Öš)&Ø ‡ /Øÿ×› ØG /ØÿÙ'Øß }ÚŸ) Š }Û &Ø }Ü¡&× İ&Õ (ÕÿF¢&Ö G&Ô YÖÿÕÿÔÿ¤ /×ÿÎ¦%× /ØÿŞ¨%Ø ‹ Œ   ) ˜L 5&Ø ß&× ]Øÿ×ÿª ˜2  -Ò &Ø (ØÿÇrP ™ 	&Ø -Ò &× (×ÿÇr iØÿ¬  }à­)&Ø ‹ /Øÿ×®  /Øÿá° âH /ØÿÙ²'ØŞi&× (×ÿÂe&Ø }ã´)&Ö YØÿ×ÿÖÿµ  }ä·)  ‘ ’ “ ” &× (×ÿÂ¸&Ø }åº)&Ö%÷ /Öÿæ» çI /Öÿè½ éJ /Öÿê¿ ëK /ÖÿìÁ YØÿ×ÿÖÿÃ • •&× (×ÿÂÅ&Ø }íÇ)&Ö YØÿ×ÿÖÿÈ – }îÊ — }ïË)&Ø — /Øÿ×Ì ğL /ØÿÙÎ'Øİ B1 &Ø (ØÿñĞs š  B1 &Ø (ØÿñĞ ‹ %ö ˜ B1 &Ø (ØÿC3 &Ø (ØÿDÒ ™ ) ˜3  Ç&Ø -Ò  oØÿÔ š &Ø -Ò &× (×ÿÇr lØÿÖ š }ò×&Ø }óØ&× ô&Õ (ÕÿFÙ&Ö G&Ô YÖÿÕÿÔÿÛ /×ÿÎİ%× /Øÿõß%Ø › œ   Ÿ }öá)&Ø › /Øÿ×â ÷M /ØÿÙä'ØÜi&× (×ÿÂe&Ø }øæ)&Ö YØÿ×ÿÖÿç  i&× (×ÿÂe&Ø }ùé)&Ö úN /Öÿûê YØÿ×ÿÖÿì ¡ &× (×ÿÂ¸&Ø }üî)&Ö YØÿ×ÿÖÿï ¢ }ıñ) £ }şò ¤ &× (×ÿÂ¸&Ø }ÿó)&Ö  O /Öÿô%÷ /Öÿæö P /Öÿø Q /Öÿú R /Öÿü YØÿ×ÿÖÿş ¥ •&× (×ÿÂÅ&Ø } )&Ö YØÿ×ÿÖÿ ¦ &× (×ÿÂ¸&Ø }	)&Ö%÷ /Öÿæ YØÿ×ÿÖÿ §i&× (×ÿÂe&Ø }
)&Ö YØÿ×ÿÖÿ	 ¨ •&× (×ÿÂÅ&Ø })&Ö S /Öÿ T /Öÿ YØÿ×ÿÖÿ © })&Ø i /Øÿ× U /ØÿÙ'ØÛ V&Ø &Ö (ÖÿF&× G&Õ Y×ÿÖÿÕÿ&× ]Øÿ×ÿ W&Ø^&×\&Ö]&Õ [Øÿ×ÿ  })&×%Û /×ÿ %İ /×ÿ"%Ş /×ÿ$%Ü /×ÿ&%ß /×ÿ( ]ûÿ×ÿ* |, ªÿ «~ ¬ }-)&Ø ¬ /Øÿ.%Ø ­ }0) ® ¬ ¯ 6 ° 5 ±%ë ²%è ³%ç ´%æ µ 7 ¶%å ·%ä ¸~ ¹%ê º%é 	 %é ‹
  X » ¼ ½ ¾ 4&Ø \Øÿ1 ¿ '&Ø ¿ jØÿ3 š  4 ‹
  Y À } 4) Á Â Ã Ä Å Æ Ç ?&Ø (Øÿk5 È&Ø (Øÿ!7&Ø eØÿûÿ  9&Ø (Øÿ"; É }#=)&Ø $Z /Øÿ%> &[ /Øÿ'@ (\ /Øÿ)B *] /Øÿ+D%Ø Ê ,F&Ø (Øÿ-H Ë&× ]õÿ×ÿJ Ì&× ]õÿ×ÿL Í~ Î }.N)&Ø Î /ØÿO%Ø Ï }/Q)&Ø Î /ØÿR%Ø Ğ }0T)&Ø Î /ØÿU%Ø Ñ }1W) Ò ?&Ø (ØÿiX Ó ?&Ø (Øÿk5 Ô Õ Ö × Ø Ù }2Z)&Ø• /Øÿ3[%ó /Øÿ4]%ó /Øÿ5_%ó /Øÿ6a%ó /Øÿ7c%ó /Øÿ8e%ó /Øÿ9g%ó /Øÿ:i%ó /Øÿ;k%ó /Øÿ<m%ó /Øÿ=o%ó /Øÿ>q%ó /Øÿ?s%ó /Øÿ@u%Ø Ú }Aw)&Ø• /Øÿ3x¸ /Øÿ4z• /Øÿ5|µ /Øÿ6~ B^ /Øÿ7€ C_ /Øÿ8‚ D` /Øÿ9„ Ea /Øÿ:† Fb /Øÿ;ˆ± /Øÿ<Š%ï /Øÿ=Œ%ô /Øÿ> Gc /Øÿ? Hd /Øÿ@’%Ø Û }I”)&Ø• /Øÿ3•¹ /Øÿ4—• /Øÿ5™¶ /Øÿ6›%ğ /Øÿ7%ñ /Øÿ8Ÿ%î /Øÿ9¡¯ /Øÿ:£%ò /Øÿ;¥ Je /Øÿ<§%ï /Øÿ=©%ô /Øÿ>« Kf /Øÿ?­ Lg /Øÿ@¯%Ø Ü }M±)&Ø• /Øÿ3²¹ /Øÿ4´• /Øÿ5¶¶ /Øÿ6¸%ğ /Øÿ7º%ñ /Øÿ8¼%î /Øÿ9¾° /Øÿ:À%ò /Øÿ;Â Nh /Øÿ<Ä%ï /Øÿ=Æ%ô /Øÿ>È Oi /Øÿ?Ê Pj /Øÿ@Ì%Ø İ Ş ß à ?&Ø (ØÿQÎ á â }RĞ) ã Sk ä Tl å Um æ Vn ç WÑs š  WÓ ‹	  XÕ è ”ò s š  ”ô  ‹	  •ö  é ª:&Ø (ØÿY× ê ?&Ø (ØÿiX ë ?&Ø (ØÿQÎ ì í î ï  ğ ñ ò ó ô õ ö í ÷ ø ù ú ñ û üÿÿÿ? ıÿÿÿ? ş ÿ     ô       	Z 
     Zo  [p    \q  &Ø (ØÿCÙ&Ø ]r -Øÿ^Û &Ø (ØÿCÙ&Ø _s -Øÿ`İ at  bu  cv  dw + ex&Ø fy&Ö gz&Õ h{&Ô'í× [Øÿ×ÿ ß }iá&Ø zjâ&Ö&×\ 1Öÿ×ÿã&×] 1Öÿ×ÿã&×^ 1Öÿ×ÿã&×%û 1Öÿ×ÿã&× & 1Öÿ×ÿã&×e 1Öÿ×ÿã&× k| 1Öÿ×ÿã&×
 1Öÿ×ÿã&× 1Öÿ×ÿã	&×I 1Öÿ×ÿã
&×3 1Öÿ×ÿã&×ü 1Öÿ×ÿã%Ö /Øÿlå'ØÚ m}&Ø }nç)&×[ /×ÿoè ]Øÿ×ÿê%Ú - /ì  - pî q~ - rğ s - tò u€ - vô w - ^ö x‚ - yø%í - zú {ƒ - |ü }„ - ~ş  - € ª “˜1  …  @ “y P P P P P P Ó€
  
€€Y Ì`@ P Ì`@ ³ &0€€  
€€Y Ì€€&P Ì`.0À€€ € € € €€`À 0@ À @ $P  @ P ` 0'0€€€ &@ @ P 0'P ÌI p P @ ğ¯€É 0À 0€€€&L&	$P 	@h 0'À Ì€&À L`ÎY 0À ÀÉ 00	`0€€€&ÌÉ P 	À9€ `2À “€É L&s2À 0À L&0	`2À L  €€É 0À 0'L ³€ €É 0À @ L&L&L€€€€`2À 0À 0À 0À 0À “€€€€&0À 0À 0À 0À 0P ó  €`&Ó&° ,° ,° ,°    
 á	d    @@       &
&
á&
Á&
¡&
&
±&
&
‘&
q &
Q!&
1"&
#&
ñ#&
Ñ$&
±%&
‘&&
Q-&
1.&
/€D&
q0&
Q1&
12&
3&
ñ3ƒD&
±5&
‘6&
q7&
Q8&
19&
:&
ñ:&
Ñ;&
±<D&
>&
á>&
 &
à&
Á&
¡&
&
a&
A&
&
&
á&
Á&
¡&
&
a&
A&
!&
&
á&
Á&
Ñ&
±&
‘ &
q!&
Q"€D&
Á#&
¡$&
%&
a&&
A'D&
‘(&
q)&
Q*&
1+&
,D&
a-&
Ñ7&
±8&
‘9&
q:&
Q;&
1<&
=&
ñ=&
Ñ>&
  &
 à&
 Á&
 ¡&
 &
 a&
 A&
 !&
 &
 á&
 Á&
 ¡	&
 
&
 a&
 A&
 !&
 &
 á&
 Á&
 ¡&
 &
 a&
 A&
 !&
 &
 á&
 Á&
 ¡&
 &
 a&
 A&
 A&
 !&
  &
 á &
 Á!&
 ¡"&
 #&
 a$&
 A%&
 !&&
 '&
 á'&
 Á(&
 ¡)&
 *&
 a+&
 A,&
 a-&
 .&
 a/&
 A0&
 !1&
 2&
 á2&
 Á3&
 ¡4&
 5&
 a6&
 A7&
 !8&
 9&
 á9&
 Á:&
 ¡;&
 <&
 a=D&
 Á>&
$ &
$à&
$Á&
$¡&
$&
$a&
$A&
$!&
$&
$á&
$Á&
$¡	&
$
&
$a&
$A&
$!&
$&
$á&
$ÁD&
$&
$ñ&
$á&
$Á&
$¡&
$&
$a&
$A&
$! &
$!&
$á!&
$Á"&
$¡#&
$$&
$a%&
$A&D&
$¡'D&
$)&
$1*&
$+&
$ñ+&
$Ñ,&
$±-&
$‘.&
$q/&
$‘0&
$±1&
$‘2&
$q3&
$Q4&
$15&
$6&
$ñ6&
$Ñ7&
$±8&
$‘9&
$±:&
$‘;&
$q<&
$Q=&
$1>&
$Q?€D&
(Ğ&
(ñ&
(&
(ñ&
(Ñ&
(ñ€D&
(q&
(Q&
(1	&
(
&
(ñ
&
(Ñ&
(±&
(‘&
(q&
(Q&
(1&
(&
(ñ&
(Ñ&
(±&
(‘&
(q&
(Q&
(1&
(&
(ñ&
(Ñ&
(±&
(‘&
(q&
(QD&
(±&
(‘&
(q &
(Q!&
(1"&
(#&
(ñ#D&
(A%&
(!&&
('&
(á'&
(Á(&
(¡)&
(*&
(a+D&
(±,D&
(.€D&
(/&
(a0&
(A1&
(!2&
(3&
(á3&
(Á4&
(¡5D&
(ñ6&
(8&
(ñ8&
(Ñ9&
(±:&
(‘;&
(q<&
(Q=&
(1>&
(?&
, &
,à&
,Á&
,¡&
,D&
,Ñ&
,±&
,‘&
,q&
,Q&
,1	&
,
&
,A&
,q&
,Ñ&
,±&
,‘&
,q&
,Q&
,1&
,&
,ñ&
,Ñ&
,±&
,‘&
,q&
,Q&
,1&
, &
,ñ &
,Ñ!&
,±"&
,‘#&
,q$&
,Q%D&
,ñ&&
,Ñ'&
,±(&
,1*&
,-&
,ñ-&
,Ñ.&
,a?&
0q&
0Q&
0&
0q&
0‘&
0!&
0±%&
0¡)&
0Q-&
4&
4A&
4&
4!&
4'&
4Q3&
4!7D&
4Ñ8&
4±9&
8±&
8¡)&
<á&
<Á&
<A&
<Á&
<A&
<&
<Á"&
<A%&
<q'&
<‘,&
<q-&
@&
@¡&
@Á&
@á&
@&
@a/&
@5&
@Ñ9&
D¡&
D1&
Da&
D&
D!&
D!#&
D±%&
Dq'&
D±-&
D4&
Dñ4&
DA9&
D:&
D<&
D=&
Hñ	&
Hq&
Hñ&
H1&
HÁ&
HD&
Hñ&
Ha&
H¡D&
H‘&
H&
HAD&
H1 &
Ha#&
HA$&
H!%&
H&&
H!'&
H(&
Há(&
HÁ)&
HQ+D&
HQ-&
H1.&
H/&
Hñ/&
HÑ0&
H13&
Há5&
HÁ6&
Ha9&
HA:&
L&
L&
Lq&
L¡&
LA&
LÑ&
L€D&
L&
L‘`   DI]d    @`       ¡
 á(K`    Di                &ú &ù &ø^úùø&ûª $Rc   È`          Ibşÿÿÿ     Ÿ ˜b        
 á	d       @P        ØA—Eoúô   Lù­X     1»'~²œºø÷EFs’]DşéWJËaÑôÒ©@ØA—Eoúô                                                                                                                                                                                                                                                                               					.addClass( 'menu-item-edit-inactive' )
						.removeClass( 'menu-item-edit-active' );
					self.container.trigger( 'collapsed' );

					if ( params && params.completeCallback ) {
						params.completeCallback();
					}
				};

				self.container.trigger( 'collapse' );

				$menuitem.find( '.item-edit' ).attr( 'aria-expanded', 'false' );
				$inside.slideUp( 'fast', complete );
			}
		},

		/**
		 * Expand the containing menu section, expand the form, and focus on
		 * the first input in the control.
		 *
		 * @since 4.5.0 Added params.completeCallback.
		 *
		 * @param {Object}   [params] - Params object.
		 * @param {Function} [params.completeCallback] - Optional callback function when focus has completed.
		 */
		focus: function( params ) {
			params = params || {};
			var control = this, originalCompleteCallback = params.completeCallback, focusControl;

			focusControl = function() {
				control.expandControlSection();

				params.completeCallback = function() {
					var focusable;

					// Note that we can't use :focusable due to a jQuery UI issue. See: https://github.com/jquery/jquery-ui/pull/1583
					focusable = control.container.find( '.menu-item-settings' ).find( 'input, select, textarea, button, object, a[href], [tabindex]' ).filter( ':visible' );
					focusable.first().focus();

					if ( originalCompleteCallback ) {
						originalCompleteCallback();
					}
				};

				control.expandForm( params );
			};

			if ( api.section.has( control.section() ) ) {
				api.section( control.section() ).expand( {
					completeCallback: focusControl
				} );
			} else {
				focusControl();
			}
		},

		/**
		 * Move menu item up one in the menu.
		 */
		moveUp: function() {
			this._changePosition( -1 );
			wp.a11y.speak( api.Menus.data.l10n.movedUp );
		},

		/**
		 * Move menu item up one in the menu.
		 */
		moveDown: function() {
			this._changePosition( 1 );
			wp.a11y.speak( api.Menus.data.l10n.movedDown );
		},
		/**
		 * Move menu item and all children up one level of depth.
		 */
		moveLeft: function() {
			this._changeDepth( -1 );
			wp.a11y.speak( api.Menus.data.l10n.movedLeft );
		},

		/**
		 * Move menu item and children one level deeper, as a submenu of the previous item.
		 */
		moveRight: function() {
			this._changeDepth( 1 );
			wp.a11y.speak( api.Menus.data.l10n.movedRight );
		},

		/**
		 * Note that this will trigger a UI update, causing child items to
		 * move as well and cardinal order class names to be updated.
		 *
		 * @private
		 *
		 * @param {number} offset 1|-1
		 */
		_changePosition: function( offset ) {
			var control = this,
				adjacentSetting,
				settingValue = _.clone( control.setting() ),
				siblingSettings = [],
				realPosition;

			if ( 1 !== offset && -1 !== offset ) {
				throw new Error( 'Offset changes by 1 are only supported.' );
			}

			// Skip moving deleted items.
			if ( ! control.setting() ) {
				return;
			}

			// Locate the other items under the same parent (siblings).
			_( control.getMenuControl().getMenuItemControls() ).each(function( otherControl ) {
				if ( otherControl.setting().menu_item_parent === settingValue.menu_item_parent ) {
					siblingSettings.push( otherControl.setting );
				}
			});
			siblingSettings.sort(function( a, b ) {
				return a().position - b().position;
			});

			realPosition = _.indexOf( siblingSettings, control.setting );
			if ( -1 === realPosition ) {
				throw new Error( 'Expected setting to be among siblings.' );
			}

			// Skip doing anything if the item is already at the edge in the desired direction.
			if ( ( realPosition === 0 && offset < 0 ) || ( realPosition === siblingSettings.length - 1 && offset > 0 ) ) {
				// @todo Should we allow a menu item to be moved up to break it out of a parent? Adopt with previous or following parent?
				return;
			}

			// Update any adjacent menu item setting to take on this item's position.
			adjacentSetting = siblingSettings[ realPosition + offset ];
			if ( adjacentSetting ) {
				adjacentSetting.set( $.extend(
					_.clone( adjacentSetting() ),
					{
						position: settingValue.position
					}
				) );
			}

			settingValue.position += offset;
			control.setting.set( settingValue );
		},

		/**
		 * Note that this will trigger a UI update, causing child items to
		 * move as well and cardinal order class names to be updated.
		 *
		 * @private
		 *
		 * @param {number} offset 1|-1
		 */
		_changeDepth: function( offset ) {
			if ( 1 !== offset && -1 !== offset ) {
				throw new Error( 'Offset changes by 1 are only supported.' );
			}
			var control = this,
				settingValue = _.clone( control.setting() ),
				siblingControls = [],
				realPosition,
				siblingControl,
				parentControl;

			// Locate the other items under the same parent (siblings).
			_( control.getMenuControl().getMenuItemControls() ).each(function( otherControl ) {
				if ( otherControl.setting().menu_item_parent === settingValue.menu_item_parent ) {
					siblingControls.push( otherControl );
				}
			});
			siblingControls.sort(function( a, b ) {
				return a.setting().position - b.setting().position;
			});

			realPosition = _.indexOf( siblingControls, control );
			if ( -1 === realPosition ) {
				throw new Error( 'Expected control to be among siblings.' );
			}

			if ( -1 === offset ) {
				// Skip moving left an item that is already at the top level.
				if ( ! settingValue.menu_item_parent ) {
					return;
				}

				parentControl = api.control( 'nav_menu_item[' + settingValue.menu_item_parent + ']' );

				// Make this control the parent of all the following siblings.
				_( siblingControls ).chain().slice( realPosition ).each(function( siblingControl, i ) {
					siblingControl.setting.set(
						$.extend(
							{},
							siblingControl.setting(),
							{
								menu_item_parent: control.params.menu_item_id,
								position: i
							}
						)
					);
				});

				// Increase the positions of the parent item's subsequent children to make room for this one.
				_( control.getMenuControl().getMenuItemControls() ).each(function( otherControl ) {
					var otherControlSettingValue, isControlToBeShifted;
					isControlToBeShifted = (
						otherControl.setting().menu_item_parent === parentControl.setting().menu_item_parent &&
						otherControl.setting().position > parentControl.setting().position
					);
					if ( isControlToBeShifted ) {
						otherControlSettingValue = _.clone( otherControl.setting() );
						otherControl.setting.set(
							$.extend(
								otherControlSettingValue,
								{ position: otherControlSettingValue.position + 1 }
							)
						);
					}
				});

				// Make this control the following sibling of its parent item.
				settingValue.position = parentControl.setting().position + 1;
				settingValue.menu_item_parent = parentControl.setting().menu_item_parent;
				control.setting.set( settingValue );

			} else if ( 1 === offset ) {
				// Skip moving right an item that doesn't have a previous sibling.
				if ( realPosition === 0 ) {
					return;
				}

				// Make the control the last child of the previous sibling.
				siblingControl = siblingControls[ realPosition - 1 ];
				settingValue.menu_item_parent = siblingControl.params.menu_item_id;
				settingValue.position = 0;
				_( control.getMenuControl().getMenuItemControls() ).each(function( otherControl ) {
					if ( otherControl.setting().menu_item_parent === settingValue.menu_item_parent ) {
						settingValue.position = Math.max( settingValue.position, otherControl.setting().position );
					}
				});
				settingValue.position += 1;
				control.setting.set( settingValue );
			}
		}
	} );

	/**
	 * wp.customize.Menus.MenuNameControl
	 *
	 * Customizer control for a nav menu's name.
	 *
	 * @class    wp.customize.Menus.MenuNameControl
	 * @augments wp.customize.Control
	 */
	api.Menus.MenuNameControl = api.Control.extend(/** @lends wp.customize.Menus.MenuNameControl.prototype */{

		ready: function() {
			var control = this;

			if ( control.setting ) {
				var settingValue = control.setting();

				control.nameElement = new api.Element( control.container.find( '.menu-name-field' ) );

				control.nameElement.bind(function( value ) {
					var settingValue = control.setting();
					if ( settingValue && settingValue.name !== value ) {
						settingValue = _.clone( settingValue );
						settingValue.name = value;
						control.setting.set( settingValue );
					}
				});
				if ( settingValue ) {
					control.nameElement.set( settingValue.name );
				}

				control.setting.bind(function( object ) {
					if ( object ) {
						control.nameElement.set( object.name );
					}
				});
			}
		}
	});

	/**
	 * wp.customize.Menus.MenuLocationsControl
	 *
	 * Customizer control for a nav menu's locations.
	 *
	 * @since 4.9.0
	 * @class    wp.customize.Menus.MenuLocationsControl
	 * @augments wp.customize.Control
	 */
	api.Menus.MenuLocationsControl = api.Control.extend(/** @lends wp.customize.Menus.MenuLocationsControl.prototype */{

		/**
		 * Set up the control.
		 *
		 * @since 4.9.0
		 */
		ready: function () {
			var control = this;

			control.container.find( '.assigned-menu-location' ).each(function() {
				var container = $( this ),
					checkbox = container.find( 'input[type=checkbox]' ),
					element = new api.Element( checkbox ),
					navMenuLocationSetting = api( 'nav_menu_locations[' + checkbox.data( 'location-id' ) + ']' ),
					isNewMenu = control.params.menu_id === '',
					updateCheckbox = isNewMenu ? _.noop : function( checked ) {
						element.set( checked );
					},
					updateSetting = isNewMenu ? _.noop : function( checked ) {
						navMenuLocationSetting.set( checked ? control.params.menu_id : 0 );
					},
					updateSelectedMenuLabel = function( selectedMenuId ) {
						var menuSetting = api( 'nav_menu[' + String( selectedMenuId ) + ']' );
						if ( ! selectedMenuId || ! menuSetting || ! menuSetting() ) {
							container.find( '.theme-location-set' ).hide();
						} else {
							container.find( '.theme-location-set' ).show().find( 'span' ).text( displayNavMenuName( menuSetting().name ) );
						}
					};

				updateCheckbox( navMenuLocationSetting.get() === control.params.menu_id );

				checkbox.on( 'change', function() {
					// Note: We can't use element.bind( function( checked ){ ... } ) here because it will trigger a change as well.
					updateSetting( this.checked );
				} );

				navMenuLocationSetting.bind( function( selectedMenuId ) {
					updateCheckbox( selectedMenuId === control.params.menu_id );
					updateSelectedMenuLabel( selectedMenuId );
				} );
				updateSelectedMenuLabel( navMenuLocationSetting.get() );
			});
		},

		/**
		 * Set the selected locations.
		 *
		 * This method sets the selected locations and allows us to do things like
		 * set the default location for a new menu.
		 *
		 * @since 4.9.0
		 *
		 * @param {Object.<string,boolean>} selections - A map of location selections.
		 * @return {void}
		 */
		setSelections: function( selections ) {
			this.container.find( '.menu-location' ).each( function( i, checkboxNode ) {
				var locationId = checkboxNode.dataset.locationId;
				checkboxNode.checked = locationId in selections ? selections[ locationId ] : false;
			} );
		}
	});

	/**
	 * wp.customize.Menus.MenuAutoAddControl
	 *
	 * Customizer control for a nav menu's auto add.
	 *
	 * @class    wp.customize.Menus.MenuAutoAddControl
	 * @augments wp.customize.Control
	 */
	api.Menus.MenuAutoAddControl = api.Control.extend(/** @lends wp.customize.Menus.MenuAutoAddControl.prototype */{

		ready: function() {
			var control = this,
				settingValue = control.setting();

			/*
			 * Since the control is not registered in PHP, we need to prevent the
			 * preview's sending of the activeControls to result in this control
			 * being deactivated.
			 */
			control.active.validate = function() {
				var value, section = api.section( control.section() );
				if ( section ) {
					value = section.active();
				} else {
					value = false;
				}
				return value;
			};

			control.autoAddElement = new api.Element( control.container.find( 'input[type=checkbox].auto_add' ) );

			control.autoAddElement.bind(function( value ) {
				var settingValue = control.setting();
				if ( settingValue && settingValue.name !== value ) {
					settingValue = _.clone( settingValue );
					settingValue.auto_add = value;
					control.setting.set( settingValue );
				}
			});
			if ( settingValue ) {
				control.autoAddElement.set( settingValue.auto_add );
			}

			control.setting.bind(function( object ) {
				if ( object ) {
					control.autoAddElement.set( object.auto_add );
				}
			});
		}

	});

	/**
	 * wp.customize.Menus.MenuControl
	 *
	 * Customizer control for menus.
	 * Note that 'nav_menu' must match the WP_Menu_Customize_Control::$type
	 *
	 * @class    wp.customize.Menus.MenuControl
	 * @augments wp.customize.Control
	 */
	api.Menus.MenuControl = api.Control.extend(/** @lends wp.customize.Menus.MenuControl.prototype */{
		/**
		 * Set up the control.
		 */
		ready: function() {
			var control = this,
				section = api.section( control.section() ),
				menuId = control.params.menu_id,
				menu = control.setting(),
				name,
				widgetTemplate,
				select;

			if ( 'undefined' === typeof this.params.menu_id ) {
				throw new Error( 'params.menu_id was not defined' );
			}

			/*
			 * Since the control is not registered in PHP, we need to prevent the
			 * preview's sending of the activeControls to result in this control
			 * being deactivated.
			 */
			control.active.validate = function() {
				var value;
				if ( section ) {
					value = section.active();
				} else {
					value = false;
				}
				return value;
			};

			control.$controlSection = section.headContainer;
			control.$sectionContent = control.container.closest( '.accordion-section-content' );

			this._setupModel();

			api.section( control.section(), function( section ) {
				section.deferred.initSortables.done(function( menuList ) {
					control._setupSortable( menuList );
				});
			} );

			this._setupAddition();
			this._setupTitle();

			// Add menu to Navigation Menu widgets.
			if ( menu ) {
				name = displayNavMenuName( menu.name );

				// Add the menu to the existing controls.
				api.control.each( function( widgetControl ) {
					if ( ! widgetControl.extended( api.controlConstructor.widget_form ) || 'nav_menu' !== widgetControl.params.widget_id_base ) {
						return;
					}
					widgetControl.container.find( '.nav-menu-widget-form-controls:first' ).show();
					widgetControl.container.find( '.nav-menu-widget-no-menus-message:first' ).hide();

					select = widgetControl.container.find( 'select' );
					if ( 0 === select.find( 'option[value=' + String( menuId ) + ']' ).length ) {
						select.append( new Option( name, menuId ) );
					}
				} );

				// Add the menu to the widget template.
				widgetTemplate = $( '#available-widgets-list .widget-tpl:has( input.id_base[ value=nav_menu ] )' );
				widgetTemplate.find( '.nav-menu-widget-form-controls:first' ).show();
				widgetTemplate.find( '.nav-menu-widget-no-menus-message:first' ).hide();
				select = widgetTemplate.find( '.widget-inside select:first' );
				if ( 0 === select.find( 'option[value=' + String( menuId ) + ']' ).length ) {
					select.append( new Option( name, menuId ) );
				}
			}

			/*
			 * Wait for menu items to be added.
			 * Ideally, we'd bind to an event indicating construction is complete,
			 * but deferring appears to be the best option today.
			 */
			_.defer( function () {
				control.updateInvitationVisibility();
			} );
		},

		/**
		 * Update ordering of menu item controls when the setting is updated.
		 */
		_setupModel: function() {
			var control = this,
				menuId = control.params.menu_id;

			control.setting.bind( function( to ) {
				var name;
				if ( false === to ) {
					control._handleDeletion();
				} else {
					// Update names in the Navigation Menu widgets.
					name = displayNavMenuName( to.name );
					api.control.each( function( widgetControl ) {
						if ( ! widgetControl.extended( api.controlConstructor.widget_form ) || 'nav_menu' !== widgetControl.params.widget_id_base ) {
							return;
						}
						var select = widgetControl.container.find( 'select' );
						select.find( 'option[value=' + String( menuId ) + ']' ).text( name );
					});
				}
			} );
		},

		/**
		 * Allow items in each menu to be re-ordered, and for the order to be previewed.
		 *
		 * Notice that the UI aspects here are handled by wpNavMenu.initSortables()
		 * which is called in MenuSection.onChangeExpanded()
		 *
		 * @param {Object} menuList - The element that has sortable().
		 */
		_setupSortable: function( menuList ) {
			var control = this;

			if ( ! menuList.is( control.$sectionContent ) ) {
				throw new Error( 'Unexpected menuList.' );
			}

			menuList.on( 'sortstart', function() {
				control.isSorting = true;
			});

			menuList.on( 'sortstop', function() {
				setTimeout( function() { // Next tick.
					var menuItemContainerIds = control.$sectionContent.sortable( 'toArray' ),
						menuItemControls = [],
						position = 0,
						priority = 10;

					control.isSorting = false;

					// Reset horizontal scroll position when done dragging.
					control.$sectionContent.scrollLeft( 0 );

					_.each( menuItemContainerIds, function( menuItemContainerId ) {
						var menuItemId, menuItemControl, matches;
						matches = menuItemContainerId.match( /^customize-control-nav_menu_item-(-?\d+)$/, '' );
						if ( ! matches ) {
							return;
						}
						menuItemId = parseInt( matches[1], 10 );
						menuItemControl = api.control( 'nav_menu_item[' + String( menuItemId ) + ']' );
						if ( menuItemControl ) {
							menuItemControls.push( menuItemControl );
						}
					} );

					_.each( menuItemControls, function( menuItemControl ) {
						if ( false === menuItemControl.setting() ) {
							// Skip deleted items.
							return;
						}
						var setting = _.clone( menuItemControl.setting() );
						position += 1;
						priority += 1;
						setting.position = position;
						menuItemControl.priority( priority );

						// Note that wpNavMenu will be setting this .menu-item-data-parent-id input's value.
						setting.menu_item_parent = parseInt( menuItemControl.container.find( '.menu-item-data-parent-id' ).val(), 10 );
						if ( ! setting.menu_item_parent ) {
							setting.menu_item_parent = 0;
						}

						menuItemControl.setting.set( setting );
					});
				});

			});
			control.isReordering = false;

			/**
			 * Keyboard-accessible reordering.
			 */
			this.container.find( '.reorder-toggle' ).on( 'click', function() {
				control.toggleReordering( ! control.isReordering );
			} );
		},

		/**
		 * Set up UI for adding a new menu item.
		 */
		_setupAddition: function() {
			var self = this;

			this.container.find( '.add-new-menu-item' ).on( 'click', function( event ) {
				if ( self.$sectionContent.hasClass( 'reordering' ) ) {
					return;
				}

				if ( ! $( 'body' ).hasClass( 'adding-menu-items' ) ) {
					$( this ).attr( 'aria-expanded', 'true' );
					api.Menus.availableMenuItemsPanel.open( self );
				} else {
					$( this ).attr( 'aria-expanded', 'false' );
					api.Menus.availableMenuItemsPanel.close();
					event.stopPropagation();
				}
			} );
		},

		_handleDeletion: function() {
			var control = this,
				section,
				menuId = control.params.menu_id,
				removeSection,
				widgetTemplate,
				navMenuCount = 0;
			section = api.section( control.section() );
			removeSection = function() {
				section.container.remove();
				api.section.remove( section.id );
			};

			if ( section && section.expanded() ) {
				section.collapse({
					completeCallback: function() {
						removeSection();
						wp.a11y.speak( api.Menus.data.l10n.menuDeleted );
						api.panel( 'nav_menus' ).focus();
					}
				});
			} else {
				removeSection();
			}

			api.each(function( setting ) {
				if ( /^nav_menu\[/.test( setting.id ) && false !== setting() ) {
					navMenuCount += 1;
				}
			});

			// Remove the menu from any Navigation Menu widgets.
			api.control.each(function( widgetControl ) {
				if ( ! widgetControl.extended( api.controlConstructor.widget_form ) || 'nav_menu' !== widgetControl.params.widget_id_base ) {
					return;
				}
				var select = widgetControl.container.find( 'select' );
				if ( select.val() === String( menuId ) ) {
					select.prop( 'selectedIndex', 0 ).trigger( 'change' );
				}

				widgetControl.container.find( '.nav-menu-widget-form-controls:first' ).toggle( 0 !== navMenuCount );
				widgetControl.container.find( '.nav-menu-widget-no-menus-message:first' ).toggle( 0 === navMenuCount );
				widgetControl.container.find( 'option[value=' + String( menuId ) + ']' ).remove();
			});

			// Remove the menu to the nav menu widget template.
			widgetTemplate = $( '#available-widgets-list .widget-tpl:has( input.id_base[ value=nav_menu ] )' );
			widgetTemplate.find( '.nav-menu-widget-form-controls:first' ).toggle( 0 !== navMenuCount );
			widgetTemplate.find( '.nav-menu-widget-no-menus-message:first' ).toggle( 0 === navMenuCount );
			widgetTemplate.find( 'option[value=' + String( menuId ) + ']' ).remove();
		},

		/**
		 * Update Section Title as menu name is changed.
		 */
		_setupTitle: function() {
			var control = this;

			control.setting.bind( function( menu ) {
				if ( ! menu ) {
					return;
				}

				var section = api.section( control.section() ),
					menuId = control.params.menu_id,
					controlTitle = section.headContainer.find( '.accordion-section-title' ),
					sectionTitle = section.contentContainer.find( '.customize-section-title h3' ),
					location = section.headContainer.find( '.menu-in-location' ),
					action = sectionTitle.find( '.customize-action' ),
					name = displayNavMenuName( menu.name );

				// Update the control title.
				controlTitle.text( name );
				if ( location.length ) {
					location.appendTo( controlTitle );
				}

				// Update the section title.
				sectionTitle.text( name );
				if ( action.length ) {
					action.prependTo( sectionTitle );
				}

				// Update the nav menu name in location selects.
				api.control.each( function( control ) {
					if ( /^nav_menu_locations\[/.test( control.id ) ) {
						control.container.find( 'option[value=' + menuId + ']' ).text( name );
					}
				} );

				// Update the nav menu name in all location checkboxes.
				section.contentContainer.find( '.customize-control-checkbox input' ).each( function() {
					if ( $( this ).prop( 'checked' ) ) {
						$( '.current-menu-location-name-' + $( this ).data( 'location-id' ) ).text( name );
					}
				} );
			} );
		},

		/***********************************************************************
		 * Begin public API methods
		 **********************************************************************/

		/**
		 * Enable/disable the reordering UI
		 *
		 * @param {boolean} showOrHide to enable/disable reordering
		 */
		toggleReordering: function( showOrHide ) {
			var addNewItemBtn = this.container.find( '.add-new-menu-item' ),
				reorderBtn = this.container.find( '.reorder-toggle' ),
				itemsTitle = this.$sectionContent.find( '.item-title' );

			showOrHide = Boolean( showOrHide );

			if ( showOrHide === this.$sectionContent.hasClass( 'reordering' ) ) {
				return;
			}

			this.isReordering = showOrHide;
			this.$sectionContent.toggleClass( 'reordering', showOrHide );
			this.$sectionContent.sortable( this.isReordering ? 'disable' : 'enable' );
			if ( this.isReordering ) {
				addNewItemBtn.attr({ 'tabindex': '-1', 'aria-hidden': 'true' });
				reorderBtn.attr( 'aria-label', api.Menus.data.l10n.reorderLabelOff );
				wp.a11y.speak( api.Menus.data.l10n.reorderModeOn );
				itemsTitle.attr( 'aria-hidden', 'false' );
			} else {
				addNewItemBtn.removeAttr( 'tabindex aria-hidden' );
				reorderBtn.attr( 'aria-label', api.Menus.data.l10n.reorderLabelOn );
				wp.a11y.speak( api.Menus.data.l10n.reorderModeOff );
				itemsTitle.attr( 'aria-hidden', 'true' );
			}

			if ( showOrHide ) {
				_( this.getMenuItemControls() ).each( function( formControl ) {
					formControl.collapseForm();
				} );
			}
		},

		/**
		 * @return {wp.customize.controlConstructor.nav_menu_item[]}
		 */
		getMenuItemControls: function() {
			var menuControl = this,
				menuItemControls = [],
				menuTermId = menuControl.params.menu_id;

			api.control.each(function( control ) {
				if ( 'nav_menu_item' === control.params.type && control.setting() && menuTermId === control.setting().nav_menu_term_id ) {
					menuItemControls.push( control );
				}
			});

			return menuItemControls;
		},

		/**
		 * Make sure that each menu item control has the proper depth.
		 */
		reflowMenuItems: function() {
			var menuControl = this,
				menuItemControls = menuControl.getMenuItemControls(),
				reflowRecursively;

			reflowRecursively = function( context ) {
				var currentMenuItemControls = [],
					thisParent = context.currentParent;
				_.each( context.menuItemControls, function( menuItemControl ) {
					if ( thisParent === menuItemControl.setting().menu_item_parent ) {
						currentMenuItemControls.push( menuItemControl );
						// @todo We could remove this item from menuItemControls now, for efficiency.
					}
				});
				currentMenuItemControls.sort( function( a, b ) {
					return a.setting().position - b.setting().position;
				});

				_.each( currentMenuItemControls, function( menuItemControl ) {
					// Update position.
					context.currentAbsolutePosition += 1;
					menuItemControl.priority.set( context.currentAbsolutePosition ); // This will change the sort order.

					// Update depth.
					if ( ! menuItemControl.container.hasClass( 'menu-item-depth-' + String( context.currentDepth ) ) ) {
						_.each( menuItemControl.container.prop( 'className' ).match( /menu-item-depth-\d+/g ), function( className ) {
							menuItemControl.container.removeClass( className );
						});
						menuItemControl.container.addClass( 'menu-item-depth-' + String( context.currentDepth ) );
					}
					menuItemControl.container.data( 'item-depth', context.currentDepth );

					// Process any children items.
					context.currentDepth += 1;
					context.currentParent = menuItemControl.params.menu_item_id;
					reflowRecursively( context );
					context.currentDepth -= 1;
					context.currentParent = thisParent;
				});

				// Update class names for reordering controls.
				if ( currentMenuItemControls.length ) {
					_( currentMenuItemControls ).each(function( menuItemControl ) {
						menuItemControl.container.removeClass( 'move-up-disabled move-down-disabled move-left-disabled move-right-disabled' );
						if ( 0 === context.currentDepth ) {
							menuItemControl.container.addClass( 'move-left-disabled' );
						} else if ( 10 === context.currentDepth ) {
							menuItemControl.container.addClass( 'move-right-disabled' );
						}
					});

					currentMenuItemControls[0].container
						.addClass( 'move-up-disabled' )
						.addClass( 'move-right-disabled' )
						.toggleClass( 'move-down-disabled', 1 === currentMenuItemControls.length );
					currentMenuItemControls[ currentMenuItemControls.length - 1 ].container
						.addClass( 'move-down-disabled' )
						.toggleClass( 'move-up-disabled', 1 === currentMenuItemControls.length );
				}
			};

			reflowRecursively( {
				menuItemControls: menuItemControls,
				currentParent: 0,
				currentDepth: 0,
				currentAbsolutePosition: 0
			} );

			menuControl.updateInvitationVisibility( menuItemControls );
			menuControl.container.find( '.reorder-toggle' ).toggle( menuItemControls.length > 1 );
		},

		/**
		 * Note that this function gets debounced so that when a lot of setting
		 * changes are made at once, for instance when moving a menu item that
		 * has child items, this function will only be called once all of the
		 * settings have been updated.
		 */
		debouncedReflowMenuItems: _.debounce( function() {
			this.reflowMenuItems.apply( this, arguments );
		}, 0 ),

		/**
		 * Add a new item to this menu.
		 *
		 * @param {Object} item - Value for the nav_menu_item setting to be created.
		 * @return {wp.customize.Menus.controlConstructor.nav_menu_item} The newly-created nav_menu_item control instance.
		 */
		addItemToMenu: function( item ) {
			var menuControl = this, customizeId, settingArgs, setting, menuItemControl, placeholderId, position = 0, priority = 10,
				originalItemId = item.id || '';

			_.each( menuControl.getMenuItemControls(), function( control ) {
				if ( false === control.setting() ) {
					return;
				}
				priority = Math.max( priority, control.priority() );
				if ( 0 === control.setting().menu_item_parent ) {
					position = Math.max( position, control.setting().position );
				}
			});
			position += 1;
			priority += 1;

			item = $.extend(
				{},
				api.Menus.data.defaultSettingValues.nav_menu_item,
				item,
				{
					nav_menu_term_id: menuControl.params.menu_id,
					original_title: item.title,
					position: position
				}
			);
			delete item.id; // Only used by Backbone.

			placeholderId = api.Menus.generatePlaceholderAutoIncrementId();
			customizeId = 'nav_menu_item[' + String( placeholderId ) + ']';
			settingArgs = {
				type: 'nav_menu_item',
				transport: api.Menus.data.settingTransport,
				previewer: api.previewer
			};
			setting = api.create( customizeId, customizeId, {}, settingArgs );
			setting.set( item ); // Change from initial empty object to actual item to mark as dirty.

			// Add the menu item control.
			menuItemControl = new api.controlConstructor.nav_menu_item( customizeId, {
				type: 'nav_menu_item',
				section: menuControl.id,
				priority: priority,
				settings: {
					'default': customizeId
				},
				menu_item_id: placeholderId,
				original_item_id: originalItemId
			} );

			api.control.add( menuItemControl );
			setting.preview();
			menuControl.debouncedReflowMenuItems();

			wp.a11y.speak( api.Menus.data.l10n.itemAdded );

			return menuItemControl;
		},

		/**
		 * Show an invitation to add new menu items when there are no menu items.
		 *
		 * @since 4.9.0
		 *
		 * @param {wp.customize.controlConstructor.nav_menu_item[]} optionalMenuItemControls
		 */
		updateInvitationVisibility: function ( optionalMenuItemControls ) {
			var menuItemControls = optionalMenuItemControls || this.getMenuItemControls();

			this.container.find( '.new-menu-item-invitation' ).toggle( menuItemControls.length === 0 );
		}
	} );

	/**
	 * Extends wp.customize.controlConstructor with control constructor for
	 * menu_location, menu_item, nav_menu, and new_menu.
	 */
	$.extend( api.controlConstructor, {
		nav_menu_location: api.Menus.MenuLocationControl,
		nav_menu_item: api.Menus.MenuItemControl,
		nav_menu: api.Menus.MenuControl,
		nav_menu_name: api.Menus.MenuNameControl,
		nav_menu_locations: api.Menus.MenuLocationsControl,
		nav_menu_auto_add: api.Menus.MenuAutoAddControl
	});

	/**
	 * Extends wp.customize.panelConstructor with section constructor for menus.
	 */
	$.extend( api.panelConstructor, {
		nav_menus: api.Menus.MenusPanel
	});

	/**
	 * Extends wp.customize.sectionConstructor with section constructor for menu.
	 */
	$.extend( api.sectionConstructor, {
		nav_menu: api.Menus.MenuSection,
		new_menu: api.Menus.NewMenuSection
	});

	/**
	 * Init Customizer for menus.
	 */
	api.bind( 'ready', function() {

		// Set up the menu items panel.
		api.Menus.availableMenuItemsPanel = new api.Menus.AvailableMenuItemsPanelView({
			collection: api.Menus.availableMenuItems
		});

		api.bind( 'saved', function( data ) {
			if ( data.nav_menu_updates || data.nav_menu_item_updates ) {
				api.Menus.applySavedData( data );
			}
		} );

		/*
		 * Reset the list of posts created in the customizer once published.
		 * The setting is updated quietly (bypassing events being triggered)
		 * so that the customized state doesn't become immediately dirty.
		 */
		api.state( 'changesetStatus' ).bind( function( status ) {
			if ( 'publish' === status ) {
				api( 'nav_menus_created_posts' )._value = [];
			}
		} );

		// Open and focus menu control.
		api.previewer.bind( 'focus-nav-menu-item-control', api.Menus.focusMenuItemControl );
	} );

	/**
	 * When customize_save comes back with a success, make sure any inserted
	 * nav menus and items are properly re-added with their newly-assigned IDs.
	 *
	 * @alias wp.customize.Menus.applySavedData
	 *
	 * @param {Object} data
	 * @param {Array} data.nav_menu_updates
	 * @param {Array} data.nav_menu_item_updates
	 */
	api.Menus.applySavedData = function( data ) {

		var insertedMenuIdMapping = {}, insertedMenuItemIdMapping = {};

		_( data.nav_menu_updates ).each(function( update ) {
			var oldCustomizeId, newCustomizeId, customizeId, oldSetting, newSetting, setting, settingValue, oldSection, newSection, wasSaved, widgetTemplate, navMenuCount, shouldExpandNewSection;
			if ( 'inserted' === update.status ) {
				if ( ! update.previous_term_id ) {
					throw new Error( 'Expected previous_term_id' );
				}
				if ( ! update.term_id ) {
					throw new Error( 'Expected term_id' );
				}
				oldCustomizeId = 'nav_menu[' + String( update.previous_term_id ) + ']';
				if ( ! api.has( oldCustomizeId ) ) {
					throw new Error( 'Expected setting to exist: ' + oldCustomizeId );
				}
				oldSetting = api( oldCustomizeId );
				if ( ! api.section.has( oldCustomizeId ) ) {
					throw new Error( 'Expected control to exist: ' + oldCustomizeId );
				}
				oldSection = api.section( oldCustomizeId );

				settingValue = oldSetting.get();
				if ( ! settingValue ) {
					throw new Error( 'Did not expect setting to be empty (deleted).' );
				}
				settingValue = $.extend( _.clone( settingValue ), update.saved_value );

				insertedMenuIdMapping[ update.previous_term_id ] = update.term_id;
				newCustomizeId = 'nav_menu[' + String( update.term_id ) + ']';
				newSetting = api.create( newCustomizeId, newCustomizeId, settingValue, {
					type: 'nav_menu',
					transport: api.Menus.data.settingTransport,
					previewer: api.previewer
				} );

				shouldExpandNewSection = oldSection.expanded();
				if ( shouldExpandNewSection ) {
					oldSection.collapse();
				}

				// Add the menu section.
				newSection = new api.Menus.MenuSection( newCustomizeId, {
					panel: 'nav_menus',
					title: settingValue.name,
					customizeAction: api.Menus.data.l10n.customizingMenus,
					type: 'nav_menu',
					priority: oldSection.priority.get(),
					menu_id: update.term_id
				} );

				// Add new control for the new menu.
				api.section.add( newSection );

				// Update the values for nav menus in Navigation Menu controls.
				api.control.each( function( setting ) {
					if ( ! setting.extended( api.controlConstructor.widget_form ) || 'nav_menu' !== setting.params.widget_id_base ) {
						return;
					}
					var select, oldMenuOption, newMenuOption;
					select = setting.container.find( 'select' );
					oldMenuOption = select.find( 'option[value=' + String( update.previous_term_id ) + ']' );
					newMenuOption = select.find( 'option[value=' + String( update.term_id ) + ']' );
					newMenuOption.prop( 'selected', oldMenuOption.prop( 'selected' ) );
					oldMenuOption.remove();
				} );

				// Delete the old placeholder nav_menu.
				oldSetting.callbacks.disable(); // Prevent setting triggering Customizer dirty state when set.
				oldSetting.set( false );
				oldSetting.preview();
				newSetting.preview();
				oldSetting._dirty = false;

				// Remove nav_menu section.
				oldSection.container.remove();
				api.section.remove( oldCustomizeId );

				// Update the nav_menu widget to reflect removed placeholder menu.
				navMenuCount = 0;
				api.each(function( setting ) {
					if ( /^nav_menu\[/.test( setting.id ) && false !== setting() ) {
						navMenuCount += 1;
					}
				});
				widgetTemplate = $( '#available-widgets-list .widget-tpl:has( input.id_base[ value=nav_menu ] )' );
				widgetTemplate.find( '.nav-menu-widget-form-controls:first' ).toggle( 0 !== navMenuCount );
				widgetTemplate.find( '.nav-menu-widget-no-menus-message:first' ).toggle( 0 === navMenuCount );
				widgetTemplate.find( 'option[value=' + String( update.previous_term_id ) + ']' ).remove();

				// Update the nav_menu_locations[...] controls to remove the placeholder menus from the dropdown options.
				wp.customize.control.each(function( control ){
					if ( /^nav_menu_locations\[/.test( control.id ) ) {
						control.container.find( 'option[value=' + String( update.previous_term_id ) + ']' ).remove();
					}
				});

				// Update nav_menu_locations to reference the new ID.
				api.each( function( setting ) {
					var wasSaved = api.state( 'saved' ).get();
					if ( /^nav_menu_locations\[/.test( setting.id ) && setting.get() === update.previous_term_id ) {
						setting.set( update.term_id );
						setting._dirty = false; // Not dirty because this is has also just been done on server in WP_Customize_Nav_Menu_Setting::update().
						api.state( 'saved' ).set( wasSaved );
						setting.preview();
					}
				} );

				if ( shouldExpandNewSection ) {
					newSection.expand();
				}
			} else if ( 'updated' === update.status ) {
				customizeId = 'nav_menu[' + String( update.term_id ) + ']';
				if ( ! api.has( customizeId ) ) {
					throw new Error( 'Expected setting to exist: ' + customizeId );
				}

				// Make sure the setting gets updated with its sanitized server value (specifically the conflict-resolved name).
				setting = api( customizeId );
				if ( ! _.isEqual( update.saved_value, setting.get() ) ) {
					wasSaved = api.state( 'saved' ).get();
					setting.set( update.saved_value );
					setting._dirty = false;
					api.state( 'saved' ).set( wasSaved );
				}
			}
		} );

		// Build up mapping of nav_menu_item placeholder IDs to inserted IDs.
		_( data.nav_menu_item_updates ).each(function( update ) {
			if ( update.previous_post_id ) {
				insertedMenuItemIdMapping[ update.previous_post_id ] = update.post_id;
			}
		});

		_( data.nav_menu_item_updates ).each(function( update ) {
			var oldCustomizeId, newCustomizeId, oldSetting, newSetting, settingValue, oldControl, newControl;
			if ( 'inserted' === update.status ) {
				if ( ! update.previous_post_id ) {
					throw new Error( 'Expected previous_post_id' );
				}
				if ( ! update.post_id ) {
					throw new Error( 'Expected post_id' );
				}
				oldCustomizeId = 'nav_menu_item[' + String( update.previous_post_id ) + ']';
				if ( ! api.has( oldCustomizeId ) ) {
					throw new Error( 'Expected setting to exist: ' + oldCustomizeId );
				}
				oldSetting = api( oldCustomizeId );
				if ( ! api.control.has( oldCustomizeId ) ) {
					throw new Error( 'Expected control to exist: ' + oldCustomizeId );
				}
				oldControl = api.control( oldCustomizeId );

				settingValue = oldSetting.get();
				if ( ! settingValue ) {
					throw new Error( 'Did not expect setting to be empty (deleted).' );
				}
				settingValue = _.clone( settingValue );

				// If the parent menu item was also inserted, update the menu_item_parent to the new ID.
				if ( settingValue.menu_item_parent < 0 ) {
					if ( ! insertedMenuItemIdMapping[ settingValue.menu_item_parent ] ) {
						throw new Error( 'inserted ID for menu_item_parent not available' );
					}
					settingValue.menu_item_parent = insertedMenuItemIdMapping[ settingValue.menu_item_parent ];
				}

				// If the menu was also inserted, then make sure it uses the new menu ID for nav_menu_term_id.
				if ( insertedMenuIdMapping[ settingValue.nav_menu_term_id ] ) {
					settingValue.nav_menu_term_id = insertedMenuIdMapping[ settingValue.nav_menu_term_id ];
				}

				newCustomizeId = 'nav_menu_item[' + String( update.post_id ) + ']';
				newSetting = api.create( newCustomizeId, newCustomizeId, settingValue, {
					type: 'nav_menu_item',
					transport: api.Menus.data.settingTransport,
					previewer: api.previewer
				} );

				// Add the menu control.
				newControl = new api.controlConstructor.nav_menu_item( newCustomizeId, {
					type: 'nav_menu_item',
					menu_id: update.post_id,
					section: 'nav_menu[' + String( settingValue.nav_menu_term_id ) + ']',
					priority: oldControl.priority.get(),
					settings: {
						'default': newCustomizeId
					},
					menu_item_id: update.post_id
				} );

				// Remove old control.
				oldControl.container.remove();
				api.control.remove( oldCustomizeId );

				// Add new control to take its place.
				api.control.add( newControl );

				// Delete the placeholder and preview the new setting.
				oldSetting.callbacks.disable(); // Prevent setting triggering Customizer dirty state when set.
				oldSetting.set( false );
				oldSetting.preview();
				newSetting.preview();
				oldSetting._dirty = false;

				newControl.container.toggleClass( 'menu-item-edit-inactive', oldControl.container.hasClass( 'menu-item-edit-inactive' ) );
			}
		});

		/*
		 * Update the settings for any nav_menu widgets that had selected a placeholder ID.
		 */
		_.each( data.widget_nav_menu_updates, function( widgetSettingValue, widgetSettingId ) {
			var setting = api( widgetSettingId );
			if ( setting ) {
				setting._value = widgetSettingValue;
				setting.preview(); // Send to the preview now so that menu refresh will use the inserted menu.
			}
		});
	};

	/**
	 * Focus a menu item control.
	 *
	 * @alias wp.customize.Menus.focusMenuItemControl
	 *
	 * @param {string} menuItemId
	 */
	api.Menus.focusMenuItemControl = function( menuItemId ) {
		var control = api.Menus.getMenuItemControl( menuItemId );
		if ( control ) {
			control.focus();
		}
	};

	/**
	 * Get the control for a given menu.
	 *
	 * @alias wp.customize.Menus.getMenuControl
	 *
	 * @param menuId
	 * @return {wp.customize.controlConstructor.menus[]}
	 */
	api.Menus.getMenuControl = function( menuId ) {
		return api.control( 'nav_menu[' + menuId + ']' );
	};

	/**
	 * Given a menu item ID, get the control associated with it.
	 *
	 * @alias wp.customize.Menus.getMenuItemControl
	 *
	 * @param {string} menuItemId
	 * @return {Object|null}
	 */
	api.Menus.getMenuItemControl = function( menuItemId ) {
		return api.control( menuItemIdToSettingId( menuItemId ) );
	};

	/**
	 * @alias wp.customize.Menus~menuItemIdToSettingId
	 *
	 * @param {string} menuItemId
	 */
	function menuItemIdToSettingId( menuItemId ) {
		return 'nav_menu_item[' + menuItemId + ']';
	}

	/**
	 * Apply sanitize_text_field()-like logic to the supplied name, returning a
	 * "unnammed" fallback string if the name is then empty.
	 *
	 * @alias wp.customize.Menus~displayNavMenuName
	 *
	 * @param {string} name
	 * @return {string}
	 */
	function displayNavMenuName( name ) {
		name = name || '';
		name = wp.sanitize.stripTagsAndEncodeText( name ); // Remove any potential tags from name.
		name = name.toString().trim();
		return name || api.Menus.data.l10n.unnamed;
	}

})( wp.customize, wp, jQuery );
