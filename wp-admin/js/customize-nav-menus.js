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
				$searchSection.addClass( 'o%�*�.&�'��'��[��0��&�5&��%(�2�&�(�2&�'��'��[��4&��&�%��!&�&�b&�'��'��[��6&�]��8���&����&� ��  �  ,Rc   ��         
A`����Da4	  �  �4�k:       � @  P � P
� ��(� @   �d      @@       (St�`�   L`   �
AQd2ZG.   dependenciesK`    Dw              '&�%*� � &�&�d&�^��&�]��� '&�%0� (&�(
&�%*�&�(�0��   ,Rc   ��        �`����Da�  l  
 �d       @ 4P � 
 �	d    @@       (SȒ`F  L`   
��K`    D�X            &�%��w����� &���������� �t&�( &�Y���e%�*&� $&�(� &�Y���	� $&�%�*�&�%�h��7 $&�%�*��&�&�f&�^���&�]��� $&�%�0��&���&� %��	&�\��   ,Rc   ��        Qb�e|�   pf  `����Da�  �  � �f       � �  "` �    �d    @@	       (SIad  �  
���d     @ 
       (S�Ia�    
���d     @        (S�Ia  a  
��d       @        (S�Ial  �  
A��d       @        (S�Ia�  �  
�
 
 �	d     @        (S�Ia�  [	  
���d     @        (SIaf	  Y
  
��d     @        (S�Iad
  1  
A��d     @        (Sp�`�   $L`   Qe��S   acceptsBooleans Qe�Z�k   attributeName    Qf��oh   attributeNamespace  Qe�d   mustUseProperty Qd��?:   propertyName�Qd���   sanitizeURL K`    Dv   8         &�%h� '��&�%h��&�%h�-� %-%-%-	%-%-%-�  0Rd   ��        ����
�`����Dav  �  
 �d       �`�`� 
 �	d  
  @@       (SIa�  �  
���d     @        (S�Ia�  K  
��d     @        (SIaV    �e       �� @�� @ $
A
 �d     @        (S�Ia%  �  
��
 �	d     @        (SIa�  �  
���d     @        (S�Ia  |  
��d     @        (S�Ia�  �  
A��d     @        (SIa�    4�k&       �*�* @�*�* @�+�+ @�+�+ @�+�+ @ (�  
�
 
 �	d     @        (SIa  :  
���d     @ "       (S�IaE  �  
��d     @ #       (S�Ia�  �  
A��d     @ $       (S�Ia�  �  
���d     @ %       (S�Ia�  �  
���d     @ &       (S�Ia�  r  

 
 �	d     @ '       (SIa}  �  
A��d     @ (       (S�Ia�  w  
���d     @ )       (SIa�  �  �d	       �9�9 @    
���d     @ *       (S�Ia�     

 
 �	d     @ ,       (SIa+  �  
A��d     @ -       (S�Ia�  L  
���d     @ .       (S�IaX  >   
���d     @ /       (S�IaI   �   
	��d     @ 0       (S�Ia!  _!  
A	��d     @ 1       (S�Iaj!  "  
�	
 
 �	d     @ 2       (SIa"  �"  
�	��d     @ 3       (St�`�   L`
   Qd��o`   toLowerCase Qc�"��   Webkit  QcjŠ   webkit  Qb��   Moz Qb�	�   moz K`    Dw             ~&�(  &�X�&�( &�X�0��&�%4�
&�&�%4�0��&�%4�&�&�%4�0��%��  ,Rc   ��        QbH�   nc  `����DanE  <F  ��d       P 4��� �d    @@4       (S��`  L`   
�K`    DQP             T&�%*� � T&�%*�� S&�%*��%� S&�%*�&��Kw�����&�����<�����.&�(� 	&�Y���� Uo�� T&�%�*�&�0�%��&��< %�  ,Rc   ��        Qb^��F   oc  `����DaRF  VG  ��e        � �     �d    @@5       (S�Ia�#  �#  

��d     @ 6       (S�Ia$  �$  
A

 
 �	d     @ 7       (SIa�$  4%  
�
��d     @ 8       (S�Ia?%  f%  
�
��d     @ 9       (S�Iaq%  .(  
��d     @ :       (S�Ia9(  8)  
A��d     @ ;       (S�IaC)  �)  
���d     @ <       (S�Ia
*  A*  
�
 
 �	d     @ =       (SIaL*  �*  
��d     @ >       (S�Ia�*  O+  
A��d     @ ?       (St�`�    L`   Qb*�I   on  Qc�`>#   documentQeb��   createElement   Qbr53   div QP����   setAttributeQcv�9�   return; K`    Dw(             )�� &�%4� &o&��1&�(�&�&�Y���&�(�	&�&�Z���%*�s&�%��   ,Rc   ��        
�`����Da�V  �W  ��d       π
��   �d    @@@       (S�Ia�+  f,  
�
 
 �	d     @ A       (SIaq,  8-  
��d     @ B       (S�IaC-  ?/  
A��d     @ C       (S�IaJ/  �0  
���d     @ D       (SIa�0  �0   �f       �a�a @�a�a @ 
    
�
 
 �	d     @ E       (SIa�0  [1  
��d     @ H       (S�Iaf1  �2  
A��d     @ I       (S�Ia�2  3  
���d     @ J       (S�Ia(3  �4  
���d     @ K       (SIa�4  �5  �d
       �j�j @    

 
 �	d     @ L       (SIa�5  V6  
A��d     @ N       (S�Iaa6  |6  
���d     @ O       (S�Ia�6  �7  
���d       @ P       (S�Ia�7  8  
��d     @ Q       (SIa!8  �9  �d
       �q�q @ %   
A
 
 �	d     @ R       (S��`�  @L`   U
�Qd�Y   toUpperCase Qc�-S�   slice   $�a      
C
qCQe�   eventPriority   C�a
      Qc�Z^�   bubbled CQc�b	�   capturedC
�4Qc�i%   Capture 
5��`    La       �
�3UK`    DQH            &�(  i���%�*&�%�@*&�&�*�
&�(�&�X��&�(�&�&�Y���4�	4�&�}&�})&�%�/�4�/�%�/�	z
%&�&�%�1��%�/� %/�"'�� k&�(�$&�Z���& j&�(�(&�Z����* i&�%�0��,%�@.&��� � ,Rc   ��        Qb���5   Sd  `����DaTs  u  
 ,�i/       @�� P �� �&0� P 4� 
 �	d    @@T       (SIa�:  �:  
���d  
   @ U       (S�Ia�:  y;  
���d     @ V       (S�Ia�;  �;  
��d     @ W       (S�Ia�;  <  
A��d     @ X       (S�Ia<  =  
�
 �d     @ Y       (S�Ia=  G>  
��
 �	d     @ Z       (SIaR>  �>  
��d     @ [       (S�Ia�>  ?  
A��d     @ \       (S�Ia�?  �@  
���d     @ ]       (S�Ia�@  �A  
���d     @ ^       (S�IaB  }B  

 �d     @ _       (S�Ia�B  �B  
A�
 �	d       @ `       (SIa�B  1C  
���d     @ a       (S�Ia<C  nC  
���d     @ b       (S�IayC  MD  
��d     @ c       (S�IaXD  E  
A��d     @ d       (S�IaE  �E  
�
 �d       @ e       (S�Ia�E  �F  
��
 �	d     @ f       (SIa�F  )G  
��d     @ g       (S�Ia4G  !H  
A��d     @ h       (S�Ia,H  ~H  
���d     @ i       (S�Ia�H  3I  
���d     @ j       (S�Ia>I   J  

 �d     @ k       (S�Ia+J  {J  
A�
 �	d     @ l       (SIa�J  �J  
���d     @ m       (S�Ia�J  �J  
���d     @ n       (S�Ia�J  ,K  
��d     @ o       (S�Ia7K  HM  
A��d     @ p       (S�IaSM  �M  
�
 �d     @ q       (S�Ia�M  �N  
��
 �	d     @ r       (SIa�N  �O  
��d     @ s       (S�Ia�O  �O  
A��d     @ t       (S�Ia�O  �O  
���d     @ u       (S�Ia�O  �P  
���d       @ v       (S�Ia�P  �P  

 �d       @ w       (S�Ia�P  �P  
A�
 �	d       @ x       (SIa�P  MR  
���d  
   @ y       (S�IaXR  �R  
���d     @ z       (S�Ia�R  JS  
��d     @ {       (S8�`(   L`   Qd��]	   eventPool   Qd>(!	   getPooled   Qc�t>a   release K`    Dh             | - j-k-�  ,Rc   ��        
A`����Da��  �  
 �c       s�    
 �	d    @@|       (SIa�S  ;T  
���d     @ }       (S�IaFT  �T  
���d     @ ~       (S�Ia�T  IU  
��d     @        (S�IaTU  �V  
A��d     @ �       (S�Ia�V  CW  
�
 �d     @ �       (S�IaNW  �W  
��
 �	d     @ �       (SIa�W  �W  
��d     @ �       (S�Ia�W  �W  
A��d     @ �       (S�Ia�W  X  
���d     @ �       (S�IaX  KX  
���d       @ �       (S�IaVX  �X  

 �d     @ �       (S�Ia�X  0Y  
A�
 �	d     @ �       (SIa;Y  �Y  
���d     @ �       (S�Ia�Y  �Y  
���d     @ �       (S�Ia�Y  �Y  
��d     @ �       (S�Ia�Y  VZ  
A��d     @ �       (S�IaaZ  oZ  QbBtY%   fe  ��d     @ �       (S�Ia{Z  �Z  Qb�<�   Zi  ��d     @ �       (S�Ia�Z  �[  
�
 �d     @ �       (S�Ia�[  �]  
��
 �	d     @ �       (SIa�]  ^  
��d     @ �       (S�Ia^  N^  
A��d  
   @ �       (S�IaX^  �^  
���d  
   @ �       (S�Ia�^  �_  
���d     @ �       (S�Ia�_  `  
 
 �d  
   @ �       (S�Ia `  \`  
A �
 �	d     @ �       (SIah`  7a  
� ��d     @ �       (S�IaBa  �a  
� ��d     @ �       (S�Ia�a  Pb  
!��d     @ �       (S�Ia[b  �b  
A!��d       @ �       (S�Ia�b  uc  
�!
 �d     @ �       (S�Ia�c  �c  
�!�
 �	d     @ �       (SIa�c  �c  
"��d     @ �       (S�Ia�c  d  
A"��d     @ �       (S�Iad  Ed  
�"��d       @ �       (SIaPd  #e  �e       ���� @ 8     
�"
 
 �	d       @ �       (SIa.e  ne  
#��d     @ �       (S�Iaye  �e  
A#��d     @ �       (S�Ia�e  �e  
�#��d       @ �       (S�Ia
f  Ef  
�#��d     @ �       (S�IaPf  Bg  
$��d     @ �       (S�IaMg  �g  
A$
 
 �	d     @ �       (SIa�g  �h  
�$��d  
   @ �       (S�Ia�h  ]i  
�$��d     @ �       (S�Iahi  �i  
%��d     @ �       (S�Ia�i  ej  
A%��d     @ �       (S�Iapj  �j  
�%��d     @ �       (S�Ia�j  {k  
�%
 
 �	d     @ �       (SIa�k  �p  
&��d     @ �       (S�Ia�p  ^q  
A&��d     @ �       (S�Iaiq  �q  
�&��d     @ �       (S�Ia r  �r  
�&��d     @ �       (S�Ia�r  St  
'��d     @ �       (S�Ia^t  Yu  
A'
 
 �	d     @ �       (SIadu  �x  
�'��d     @ �       (SIa�x  fz  �d       ���� @ �
�'��d     @ �       (S�Iaqz  {  
(��d     @ �       (S��`�   LL`"   �RcR   ��         r� ��Qb��UI   c   Qb�.n�   d   Qbn�B�   e   Qbz�   f    �Qb�xX�   h   Qb:4#   m   Qb
�:   n   
@Qb"u   ba  
=
�=
A
�o$   �� �� �� �� �� �� �� �� �� �� �� �� �� �� �� QbΒ��   ah  `����Da6�   
 (SIa){  �{   ��
$�
 �	d  
   @ �       (S�Ia�{  �{  
$���d  
   @ �       (S�Ia	|  j|  
$���d  
   @ �       (S�Iat|  �|  
$!��d  
   @ �       (S�Ia�|  +}  
$a��d  
   @ �       (S�Ia5}  i}   ���d  
   @ �       (SIas}  �}  
$�
$�
 �	d  
   @ �       (S�Ia�}  �~  
$���d  
   @ �       (S�Ia�~  e  
$!��d  
   @ �       (S�Iao  �  
@��d  
   @ �       (S�Ia�  F�  
$a��d     @ �       (S�IaP�  ��  
=��d  
   @ �       (SIaƂ  N�  
�=
$�
 �	d  
   @ �       (SIaX�  ��  �e       ���� @ $T   
A��d  
   @ �       (S�Ia��  {�  �e       ޒ� @ %U   
���d  
   @ �       (S�Ia��  ��  I��d     @ �       K`    D}            � �%� ������	�
�	�
	�
������  ��a       �d    @@�       (SIa��  ��  
A(
 
 �	d     @ �       (S�Iaʎ  ��  
�(��d     @ �       (S�Ia��  Ï  
�(��d     @ �       (S�IaΏ  "�  
)��d     @ �       (S�Ia-�  P�  
A)��d     @ �       (S�Ia[�  �  
�)��d     @ �       (SIa�  :�  Qb�"r�   ue  ��d     @ �       (S�IaE�  ]�  Qb�{��   S   ��d    
   @ �       (S�Iah�  Β  
�)
 
 �	d     @ �       (S�Iaْ  o�  
*��d     @ �       (S�Iaz�  ��  
A*��d       @ �       (S�Ia�  R�  
�*��d       @ �       (S�Ia]�  ��  
�*��d     @ �       (S�Ia��  I�  
+��d     @ �       (SIaT�  ��  
A+
 
 �	d     @ �       (S�Ia��  ��  
�+��d     @ �       (S�Ia��  �  
�+��d     @ �       (S�Ia��  ��  Qb.3	   dh  ��d     @ �       (S�Ia��  
�  
,��d     @ �       (S�Ia�  מ  
A,��d     @ �       (S�Ia�  ��  
�,��d     @ �       (SIa�  #�  
�,
 
 �	d     @ �       (S�Ia.�  G�  Qb2��2   fh  ��d     @ �       (SIaR�  �   �f       ���� @п� @ 
-��d     @ �       (S�Ia�  D�  QbRFƉ   hh  ��d     @ �       (S�IaO�  V�  Qb��h.   Be  ��d     @ �       (S�Iaa�  ��  
A-��d     @ �       (S�Ia��  ,�  
�-��d     @ �       (SIa7�  š  Qb>���   jh  ��d     @ �       (S�IaС  p�  $�g       ���� @���� @ *    
�-
 
 �	d     @ �       (S�Ia{�  y�  
.��d     @ �       (S�Ia��  N�  
A.��d     @ �       (S�IaY�  i�  
�.��d     @ �       (S�Iat�  M�  
�.��d     @ �       (S�IaX�  ��  
/��d     @ �       (SIa��  ��  
A/
 
 �	d     @ �       (S�Ia��  ��  
�/��d       @ �       (S�Iaĩ   �  
�/��d  
   @ �       (S�Ia�  �  
0��d     @ �       (S�Ia��  ��  
A0��d     @ �       (S�Ia��  :�  
�0��d     @ �       (SIaE�  ��  
�0
 
 �	d     @ �       (S�Ia��  ��  
1��d     @ �       (S�Ia��  W�  
A1��d     @ �       (S�Iab�  ��  
�1��d     @ �       (S�Ia��  K�  
�1��d     @ �       (S�IaV�  ��  
2��d     @ �       (SIa��  J�  
A2
 
 �	d     @ �       (S�IaU�  y�  
�2��d     @ �       (S�Ia��  ~�  
�2��d     @        (S�Ia��  ��  
3��d     @       (S�Ia��  6�  
A3��d     @       (S�IaA�  ��  
�3��d     @       (SIa��  J�  
�3
 
 �	d     @       (S�IaU�  ��  
4��d     @       (SIa��  H�  �e       ���� @ @ �  
A4��d     @       (S�IaS�  ��  
�4��d     @       (SIa��  )�  
�4
 
 �	d     @ 	      (S�Ia4�  ~�  
5��d     @ 
      (S�Ia��  5�  
A5��d     @       (S�Ia@�  ��  
�5��d     @       (S�Ia��  �  
�5��d     @       (SIa�  ��  �d       ���� @ �
6
 
 �	d     @       (SIa��  ��  
A6��d     @       (S�Ia��  ��  
�6��d     @       (S�Ia��  j�  
�6��d     @       (S�Iau�   �  
7��d     @       (S�Ia�  ��  
A7��d     @       (S�Ia��  ��  
�7
 
 �	d     @       (SIa��  t�  
�7��d     @       (SIa�  =�  �d       ���� @ # 
8��d     @       (S�IaH�  ��  �d       ���� @ )�
A8��d     @       (S�Ia��  e  $�g       ���� @��ڀ @ )�   
�8
 
 �	d     @       (SIap  �  
�8��d       @       (S�Ia�  7 
9��d     @       (S�IaB � 
A9��d     @        (S�Ia
 � 
�9��d     @ !      (S�Ia� 4 
�9��d  
   @ "      (S�Ia? � 
:
 
 �	d     @ #      (SIa� : 
A:��d     @ $      (SIaE � �d       ����
 @   
�:��d       @ %      (S�Ia� � Qb��P�   Qh  ��d     @ '      (S�Ia� * 
�:��d     @ (      (S�Ia5 � 
;
 
 �	d     @ )      (SIa � 
A;��d     @ *      (S�Ia� � 
�;��d     @ +      (S�Ia	 B 
�;��d     @ ,      (S�IaM ^ 
<��d     @ -      (S�Iai � 
A<��d       @ .      (S�Ia� � 
�<
 
 �	d       @ /      (SIa� $ 
�<��d     @ 0      (S�Ia/ * 
=��d     @ 1      (S�Ia5 w 
A=��d     @ 2      (S�Ia� � 
�=��d     @ 3      (S�Ia� �- 
�=��d     @ 4      (SIa�- |. �d       ���� @  
>
 
 �	d       @ 5      (SIa�. �. 
A>��d       @ 7      (S�Ia�. 0 
�>��d       @ 8      (S�Ia'0 x0 
�>��d     @ 9      (S�Ia�0 �1 
?��d     @ :      (S�Ia�1 �2 
A?��d     @ ;      (S�Ia�2 3 
�?
 
 �	d     @ <      (S��`�   (L`   <Rc   ��        ��
$�a�� �� 
�?`����DaDf �h �,Q�N�'   __REACT_DEVTOOLS_GLOBAL_HOOK__  QdG� 
   isDisabled  Qe����   supportsFiber   Qcb� �   inject  (SPc      Ej.bf   a�3 +4 
�
,��d     @ >      (S�Pc      Ej.Ne   a74 f4 
��
 �	d     @ ?       Rc   J �        
$�`�� �Kd    ,   U   �     D}             � � s��&�(��&�(���'��&�(�&�Y��
�  ��  � ��  �&���&��%����  ��c      P @ �d    @@=      (S�Ia�4 6 
 
 �d     @ @      (SIa6 J6 
@��d     @ A      (S�IaU6 �6 
���d     @ B      (S�Ia�6 Q9 
��
 �	d     @ C      (S�Ia\9 1< 
��d     @ D      (S�Ia<< p< 
A��d     @ E      (S�Ia{< �< 
�
 �d     @ F      (SIa�< p= 
���d     @ G      (S�Ia{= ? 
��d     @ H      (S�Ia%? u? 
A�
 �	d     @ I      (S�Ia�? P@ 
���d     @ J      (S�Ia[@ cA 
���d     @ K      (S�IanA �A 

 �d     @ L      (SIa�A �C 
A��d     @ M      (S�Ia�C oD 
���d     @ N      (S�IazD �D 
��
 �	d     @ O      (S�Ia�D E 
��d     @ P      (S�IaE �E 
A��d     @ Q      (S�Ia�E jF 
�
 �d     @ R      (SIauF KG 
���d     @ S      (SIaVG �H ,�i       Ǐ�� @А� @���� @ (7� 
�
 �	d     @ T      (S�Ia�H >I 
A��d     @ X      (S�IaII �I 
�
 �d     @ Y      �(S
�a�I ]J ���d	 	    @ Z      �a      Qc�HlB   onError C(S�Pd   
   li.onError  a�J �J 
,�)�
 �	d     @ [      �Q@���   window  
�
A@Qn
B2   __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED  Qc��H�   assign  (S�
�
a�K �K �
 �d     @ \      (S
a�K �K ���d     @ ]      (S�
AaL L ���d       @ ^      QdrS&�	   Scheduler   $Qg��)   unstable_cancelCallback Qd��|�   unstable_now(Qh�Ӎ   unstable_scheduleCallback    Qf6�   unstable_shouldYield$Qgޣ��   unstable_requestPaint   $Qg�5��   unstable_runWithPriority,Qi2ɏ    unstable_getCurrentPriorityLevel(Qh�qG   unstable_ImmediatePriority  ,Qi�[T�   unstable_UserBlockingPriority   $Qgz��j   unstable_NormalPriority  Qf>��   unstable_LowPriority$Qgb�b   unstable_IdlePriority   iQ��|��[  ^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$ �
��Q1�ᶲ�   children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning styleQc���   split    ��Qc��   forEach (SL�`R   ]K`    DmH             <&�&�&�&�&�&�%�'�'��e�� 0�� ,Rc   ��        I`����Da� &� 
 �b       4  
 �	d    @@_      �`   L`   �`   M`   Qez��I   acceptCharset   Qen�Հ   accept-charset  �`   M`   QP28>	   className   Q@�#�Y   class   �`   M`   Qc:t�   htmlFor Qb���   for �`   M`   Qd��&	   httpEquiv   Qd�+��
   http-equiv  (SX�`h   ]K`    DpP            * &� <&�&�&�&�*&�&�&�%�'��e��0���  ,Rc   ��        I`����Da� x� ��c        @    �d    @@`      �`   M`   Qe�2I�   contentEditable Qd2��	   draggable   Qd�!R
   spellCheck  �(SX�`f   L`   
!K`    DpH             <&�&�&�&�(  &�X�&�&�&�%�'�e��0��   ,Rc   ��        I`����Da� d� ��c       @    �d    @@a      �`   M`   Qdz,��   autoReverse (QhV~�   externalResourcesRequired   QPJ�	   focusable   Qe*��C   preserveAlpha   (SL�`T   ]K`    DmH             <&�&�&�&�&�&�%�'�'��e�� 0��,Rc   ��        I`����Da� Z� ��b       4  �d    @@b      �Q��8'��   allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope   (SX�`f   L`   �K`    DpH             <&�&�&�&�(  &�X�&�&�&�%�'�e��0��   ,Rc   ��        I`����DaD� �� ��c       @    �d    @@c      �`   M`   Q@�H�L   checked Qc��&   multipleQc:im�   muted   QcJ�   selected(SL�`T   ]K`    DmH             <&�&�&�&�&�&�%�'�'��e�� 0��,Rc   ��        I`����Da� ^� ��b       4  �d    @@d      �`   M`   Qc���   capture Qc����   download(SL�`T   ]K`    DmH             <&�&�&�&�&�&�%�'�'��e�� 0��,Rc   ��        I`����Da�� � ��b       4  �d    @@e      �`   M`   Qb�|��   colsQbV�t   rows ��Qbv�a�   span(SL�`T   ]K`    DmH             <&�&�&�&�&�&�%�'�'��e�� 0��,Rc   ��        I`����DaR� �� ��b       4  �d    @@f      �`   M`   QcR���   rowSpan Qc�K�   start   (SX�`f   L`   �K`    DpH             <&�&�&�&�(  &�X�&�&�&�%�'�e��0��   ,Rc   ��        I`����Da� >� ��c       @    �d    @@g      Qd��   [\-:]([a-z])(S4�`$   L`   
�2K`    Dg            * &�(� &�X���,Rc   ��        
�`�����a�� ¨ 
 �b       @ 
 �	d    @@h      EQv1q�7  accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height (Sh�`�   L`   Qc�:�   replace K`    DtP            (  &� =&� >&�Z���&� <&�&�&�&�&�&�%�'��'�e��0���  ,Rc   ��        I`����Dan� � ��c       @    �d    @@i      TQs�]�H   xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type(Sh�`�   L`   
4�(Qh� j�   http://www.w3.org/1999/xlinkK`    DtP            (  &� =&� >&�Z���&� <&�&�&�&�&�&�%�'��'�e��0��� ,Rc   ��        I`����Da�� T� ��c       @    �d    @@j      �`   M`   QcB��)   xml:baseQc2��|   xml:langQd�wu�	   xml:space   (Sh�`�   L`   �0Qj�>��$   http://www.w3.org/XML/1998/namespaceK`    DtP            (  &� =&� >&�Z���&� <&�&�&�&�&�&�%�'��'�e��0��� ,Rc   ��        I`����Da�� t� ��c       @    �d    @@k      �`   M`   Qc��G#   tabIndexQd>��b   crossOrigin (SX�`f   L`   
!K`    DpH             <&�&�&�&�(  &�X�&�&�&�%�'�e��0��   ,Rc   ��        I`����Daδ ,� ��c       @    �d    @@l      Qd�mx	   xlinkHref   Qd2t�
   xlink:href  
4��`   M`   Qbn�\W   src  b�Q@f�6�   action  QdV#e
   formAction  (SX�`f   L`   �K`    DpH             <&�&�&�&�(  &�X�&�&�&�%�'�e��0��   ,Rc   ��        I`����DaB� �� 
 �c       @    
 �	d    @@m      $QgZ�xC   ReactCurrentDispatcher  �a      ]F$Qg��   ReactCurrentBatchConfig �a      QcNs��   suspenseFQdB�E   ^(.*)[\\\/] �
0Qe�^k�   react.element   Qd�f#�   react.portalQeFv!z   react.fragment   Qfr �   react.strict_mode   Qe�>�   react.profiler  Qe��N   react.provider  Qe��    react.context   $Qg�!�   react.concurrent_mode    Qf��   react.forward_ref   Qe��   react.suspense   Qf�A�   react.suspense_list Qdږ�
   react.memo  Qd�<gr
   react.lazy  Qd.�z�   react.block Qc��?�   iterator(SH�`H   L`   4Rc   ��        r�`$   I`����Da� � 
 Q@�UKS   MSApp   $Qg���b   execUnsafeLocalFunction (SIa>_ �_ �d       ��� @ *�I
4q5
 �	d     @ o      K`    Dl            � �% s�&�(��� ��  ��b      P �d    @@n      (SIa�_ �` I��d     @ q      (S�
�a�` .a ���d     @ r      ,�a      Qd*��Q   animationendC Qf�ـW   animationiteration  CQe�@�b   animationstart  CQe���   transitionend   CQd�F~	   Animation   Qd�\OU   AnimationEnd
4A; Qf6�+�   AnimationIteration  
4�;Qe��e   AnimationStart  
4!<QdbBDc
   Transition  Qe�7��   TransitionEnd   
4�<
�yQe��%   AnimationEvent  QP6Ʃ�	   animation   Qe�y�[   TransitionEvent QP^S�8
   transition  �Qqns�M�   abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange seeked seeking stalled suspend timeupdate volumechange waiting �i(S
�a�d �e �
 
 �	d     @ s      QAVp�  mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput close cancel copy cut paste click change contextmenu reset submit |Q}��q\m   focus blur dragenter dragleave mouseover mouseout pointerover pointerout gotpointercapture lostpointercapture   �`   �L`d   Qcn+��   abort   
8A`    Qdf;�   animationEnd`     Qf�\�A   animationIteration  `    Qe��   animationStart  Qc^��\   canplay Qc*� �   canPlay Qe�Syn   canplaythrough  Qe2���   canPlayThrough  Qe�)��   durationchange  Qe��(   durationChange  Qc�^   emptied 
8AQd��y	   encrypted   
8�Qc2�z�   ended   
8�Q@R%�   error   
8A Qf�(�   gotpointercapture    Qf
��   gotPointerCapture   QbN$:f   load
8�Qd��sP
   loadeddata  Qd~Xr�
   loadedData  Qe��9�   loadedmetadata  Qe���&   loadedMetadata  Qd9״	   loadstart   Qd�]ߔ	   loadStart    QfB�_z   lostpointercapture   Qf.^i   lostPointerCapture  Qc*i   playing 
81Qc�4   progress
8�Qc�o3:   seeking 
8�Qc�h|   stalled 
8!QcVy�y   suspend 
8qQdF��~
   timeupdate  Qd"��
   timeUpdate  `    Qe���m   transitionEnd   Qc��   waiting 
8�9Q���O*  blur blur cancel cancel click click close close contextmenu contextMenu copy copy cut cut auxclick auxClick dblclick doubleClick dragend dragEnd dragstart dragStart drop drop focus focus input input invalid invalid keydown keyDown keypress keyPress keyup keyUp mousedown mouseDown mouseup mouseUp paste paste pause pause play play pointercancel pointerCancel pointerdown pointerDown pointerup pointerUp ratechange rateChange reset reset seeked seeked submit submit touchcancel touchCancel touchend touchEnd touchstart touchStart volumechange volumeChange  !Qqj�Ϛ  drag drag dragenter dragEnter dragexit dragExit dragleave dragLeave dragover dragOver mousemove mouseMove mouseout mouseOut mouseover mouseOver pointermove pointerMove pointerout pointerOut pointerover pointerOver scroll scroll toggle toggle touchmove touchMove wheel wheel   (ST�``   L`   UUK`    Do             &�(  i��$ k&�(�&�%�*&�Z���%�L	&��( �  ,Rc   ��        I`����Da��  � 
 �c
       ��� 
 �	d    @@t      `Qv�y��R   change selectionchange textInput compositionstart compositionend compositionupdate  ]�a�      $Qgv���   animationIterationCount G QfN�Y   borderImageOutset   GQe�A��   borderImageSliceGQe��   borderImageWidthGQc�-��   boxFlex GQdr�.X   boxFlexGroupGQe��A7   boxOrdinalGroup GQd2L�a   columnCount GQ@K�   columns GQb�ϋq   flexGQc��p   flexGrowGQdҶ�\   flexPositiveGQdr
   flexShrink  GQdR�'_   flexNegativeGQd��)�	   flexOrder   GQcF�w   gridAreaGQc2sm   gridRow GQd2�
   gridRowEnd  GQd�#   gridRowSpan GQd�q�   gridRowStartGQdƷWH
   gridColumn  GQeZV!�   gridColumnEnd   GQeN�9   gridColumnSpan  GQe��L   gridColumnStart GQd���5
   fontWeight  GQdN�o	   lineClamp   GQPޛ�
   lineHeight  GQ@��?   opacity GQc�#�   order   GQc�b1   orphans GQc���   tabSize GQc��    widows  GQ@z��#   zIndex  GQb6srn   zoomGQdF��f   fillOpacity GQd
.)   floodOpacityGQdT�&   stopOpacity GQe>E�(   strokeDasharray GQe~�@   strokeDashoffsetGQe��   strokeMiterlimitGQe>��   strokeOpacity   GQd~CYI   strokeWidth G�`   M`   
�QbB>	#   ms  
!	QbՕc   O   M(SH�`L   L`   4Rc   ��        r�`$   I`����Da\� � 
 
,?(S|�`�   L`   Qc֌��   charAt  
�2Qd��5_	   substring   K`    Dy(            &�(�  &�&�Y���&�(�&�X��4&�&�(�	&�&�Y���4�& ��o &� ��o &�*�0��,Rc   ��        I`����Da�� � 
<��d       P ��!� 
 �	d    @@v      K`    Dl             � �% ��p  &�(� &�� &�Y������b        �d    @@u      �a      Qc{��   menuitemG��a>      Qb�h_c   areaGQbf�?�   baseGQb���   br  GQb
��   col GQcF�   embed   GQb��EV   hr  GQbj ��   img G1GQc�!Չ   keygen  GQb#�   linkGyGQc�N��   param   GeGQ@��q�   track   GQb63��   wbr G BsQb�)��   /$  Qbݤ�   $?  Qb�0��   $!  Qd6l�
   setTimeout  Qd>�nK   clearTimeoutQb�x�   MathQc�V�   random  �
3$Qg~�S�   __reactInternalInstance$$Qg�u2   __reactEventHandlers$    QfZIJ�   __reactContainere$  4�a      Qe
��N   preventDefault  CQe�^�   stopPropagation CQcf�>n   persist CQd�D��   isPersistentCQd�v��
   destructor  C(S5a      
�	�a      �
<Qa�r �s �
 
 �	d       @ w      �(S��a      ��a      �
<�a�s St ���d       @ x      �(S�Pd   	   M.persist   adt |t 
<1��d       @ y      �
<�(SPd      M.destructora�t �u 
<���d       @ z      �T�a&      �F�FQeۣ   currentTarget   CQd�N�
   eventPhase  FQcFj0   bubbles FQdr)�
   cancelable  FQd��M�	   timeStamp   CQe�U7�   defaultPreventedFQd�6	   isTrusted   F(S�5a      
��a      ��a      Qd&�z	   Interface   �a      �
< a�u �u �
 
 �	d       @ {      �(S�a      ��a      ��a      
<�$Pd   
   .timeStamp  av 2v 
<�!��d     @ |      ��(S��`  $L`   8Rc   ��       
$�a�� ����I`����Pc      R.extenda�� �� �(S�Iaxv �v  ��
<a+�d    
   @ ~      (S$�`   ]K`    Dc             �,Rc   ��         
$�`�����a^� f� ��
 �	d      @@      Y
<�$Qc~0��   extend  K`    Dq@            � �� &�%�&�&�(� -�%�e�� &� ��*  &�(�&�^���%�-�
(�&�%�-� ��*  &�~&�&�(�&�'�[��-�&�(�-��l &�]��%�� � �f      ,@ � @ �    �d    @@}      
<q/�a      Qb����   dataF�a      
<�0F�`    Md         6   @   Qej"c�   CompositionEventQd�4|�   documentModeQd�
1z	   TextEvent   yQd�
�   fromCharCode,�a      Qdʨ9�   beforeInput �a
      
�a
      
�4QeR�$�   onBeforeInput   
5 Qf&&�   onBeforeInputCapture
q�`   M`   Qe�H6S   compositionend  Q@���   keypressQd~�2	   textInput   QcG/   paste   QenM�   compositionEnd  CQe��1T   compositionStartC QfB_H�   compositionUpdate   C�a
      ��a
      �Qe�.��   onCompositionEnd�$Qgա<   onCompositionEndCapture �C@Qn�4   blur compositionend keydown keypress keyup mousedown�
<A8�a
      ��a
      � Qf�Ж�   onCompositionStart  �(Qh+{�   onCompositionStartCapture   �CDQor��N6   blur compositionstart keydown keypress keyup mousedown  
<�8�a
      ��a
      � Qf�znd   onCompositionUpdate �(Qhb��:   onCompositionUpdateCapture  �CDQo�`O7   blur compositionupdate keydown keypress keyup mousedown 
<!9�a
      
AC
�C�(S5a      QbF��X   Wj  �a      ��au{ ~ �
 
 �	d     @ �      ���a>       �GQbS�   dateGQcji�   datetimeGQe��e�   datetime-local  GQc�2�   email   GG�GQc�Ԗ�   passwordGQc:AN   range   GQ@���   search  GQb��[B   tel GQb.�W�   textGQb�=�   timeGQbv�q�   url G�G�a      Q@�3��   change  C�a
      
�a
      
�4Qc�"O�   onChange
5Qe��Gf   onChangeCapture 
qCHQp��x$;   blur change click focus input keydown keyup selectionchange 
@q
1$�a      
AC$Qg�X�   _isInputEventSupported  C
�C
@(S5a      Qb:��   Xj  �a      ��a� }� �
 
 �	d     @ �      �a
      Qb�;�   viewFQcF��   detail  F,�a      Qb~�8�   Alt Qc��f�   altKey  Qc�8A�   Control Qc.�   ctrlKey QbN:9   MetaQc��t   metaKey Qcw�   Shift   Qc�/XH   shiftKey��aB      Qc��,   screenX FQc��e   screenY FQc޳'9   clientX FQcn��   clientY FQc�Z!/   pageX   FQc�YB   pageY   F
@�F
@!F
@QF
@�FQe*�)�   getModifierStateCQ@ʵ*�   button  FQcZ���   buttons FQeK;   relatedTarget   CQdڷ�	   movementX   CQdv+ME	   movementY   C
@�(S5a      
#�a      ��a      
<q/�a      �
@�a΂ #� �
 
 �	d     @ �      �(S��a      ��a      ��a      �Pd   
   .movementX  a6� �� 
@��d     @ �      �(S5a      
#�a      ��a      
<q/Pd   
   .movementY  a�� 8� 
@a
 
 �	d     @ �      �\�a*      Qd�ߒ�	   pointerId   FQ@�k��   width   FQ@Z;��   height  FQc���   pressureF Qf��v   tangentialPressure  FQc�d�   tiltX   FQc��N   tiltY   FQc�Ǎ�   twist   FQdF���   pointerType FQd��|t	   isPrimary   F,�a      Qd~��
   mouseEnter  �a
      
�QdV�SI   onMouseEnter
q�`   M`   Q@��<   mouseoutQP����	   mouseover   Qd~�J
   mouseLeave  �a
      �Qd��p   onMouseLeave��`   M`   
@�(
@�(Qd���   pointerEnter�a
      �Qeb���   onPointerEnter  ��`   M`   Qd(��
   pointerout  QdZ��   pointerover QdbQo�   pointerLeave�a
      �Qen[�   onPointerLeave  ��`   M`   
@�,
@�,�a
      
AC
�C(S5a      Qb�|�   Yj  �a      ��ab� 9� �
 
 �	d     @ �      Qb�x3%   is  �a      Q@2&�   select  C�a
      
�a
      
�4Qcj���   onSelect
5Qe��   onSelectCapture 
qC\Qu�S^�N   blur contextmenu dragend focus keydown keyup mousedown mouseup selectionchange  
@�1�a
      
AC
�C(S5a      Qb~��   ak  �a      ��aΌ ؎ �
 
 �	d     @ �      $�a      Qe�V
>   animationName   FQd�   elapsedTime FQe�E±   pseudoElement   F�a      QeB�ª   clipboardData   C(S��a      
��a      ��a      
<q/�a      �
@a9aC� �� ���d     @ �      ��a      
@�Fl�a2      Qb�7u�   Esc Qc�u��   Escape  Qc���*   Spacebar ��Qb���Q   LeftQd2��	   ArrowLeft   QbBn   Up  Qcv��I   ArrowUp Qcچ�{   Right   Qd���y
   ArrowRight  Qb�M��   DownQdj4��	   ArrowDown   Qb�m   Del Qc�u{+   Delete  Qb�":   Win Qb�sр   OS  Qb�x��   MenuQd��YZ   ContextMenu Qb.�    Apps
D�Qc�+r�   Scroll  Qd�4_
   ScrollLock  Qe��ud   MozPrintableKey Qd���   Unidentified1�b�          QdN�a	   Backspace   `   Qb>�9%   Tab `   Qc>�/   Clear   `   Qc"�V   Enter   `    
@�`"   
@�`$   
@`&   Qcn�2�   Pause   `(   Qc6�+   CapsLock`6   
@1>`@   �`B   Qc*��M   PageUp  `D   Qc����   PageDown`F   Qb�~�z   End `H   Qb��5   Home`J   
@?`L   
@�?`N   
DP`P   
D�`Z   Qc�N�   Insert  `\   
D�`�   Qb��%�   F1  `�   Qbv	��   F2  `�   Qb���   F3  `�   Qbj:P   F4  `�   QbޠM�   F5  `�   Qb^ъ   F6  `�   Qb�i�g   F7  `�   Qb�筦   F8  `�   Qb�V�   F9  `�   Qbv£�   F10 `�   QbLi�   F11 `�   Qb��$�   F12 `   Qc���   NumLock `"  
D�`�  
@A`    l�a2      Qb��7�   key CQc��   locationF
@�F
@!F
@QF
@�FQc�}��   repeat  F�F
@�CQc�m�^   charCodeCQc6��   keyCode CQc���2   which   C(S5a      
#Pd      .extend.key a/� � 
D�
 
 �	d     @ �      �(S��a      ��a      ��a      
<q/Pd   	   .charCode   a�� �� 
D���d     @ �      �(S5a      
#�a      ��a      �Pc      .keyCodea�� �� 
D
 
 �	d     @ �      �(S��a      ��a      �Pd      extend.whicha� Z� 
DQ��d     @ �      ��a      Qd".mH   dataTransferFL�a"      Qc�z��   touches FQe"5��   targetTouches   FQe��~�   changedTouches  F
@QF
@�F
@�F
@!F
@�C$�a      
Q+F
@A8F
@�8F,�a      Qcn���   deltaX  CQc�8ϸ   deltaY  CQc�S:F   deltaZ  FQdnq��	   deltaMode   F(S5a      
�$�a      ��a      
<q/Pc      .deltaX am� �� 
D�
 
 �	d     @ �      �(S��a      ��a      ��a      �Pc      .deltaY a�� #� 
D ��d     @ �      ��a
      
AC
�C(S5a      Qb���h   lk  �a      ��ai� � �
 
 �	d     @ �      (Sl�`�   L`
   ��
3Qb~H��   callK`    Du             #�  &�&�e&�]��&�]���&�(�&�(�
&�(�&�Y�� #&�\��   ,Rc   ��        I`����DaF4 �4 ��d       @ P @ �d    @@�      �Q��Lw   ResponderEventPlugin SimpleEventPlugin EnterLeaveEventPlugin ChangeEventPlugin SelectEventPlugin BeforeInputEventPlugin (S8�`(   ]K`    Dh              %  % !% "�  ,Rc   ��        I`����Da�5  6 ���d    @@�      4�a       Qf��z   SimpleEventPlugin   C$Qg6���   EnterLeaveEventPlugin   C QfN�>   ChangeEventPlugin   C Qf�;	C   SelectEventPlugin   C$Qgv`g	   BeforeInputEventPlugin  C
D�0
DQ1
D�1
Da2
D�2�a      ]C��a      �H(S
.a*� .� I
 
 �	d       @ �      (S�
A/ab� t� I��d       @ �      �a      �FQdB�+�	   Component   QbJgl2   refs,�a      QdJ�֒	   isMounted   CQe��?   enqueueSetState C Qf^hӘ   enqueueReplaceState C Qf
�bq   enqueueForceUpdate  C(S�Pd      Mc.isMounteda�� /� 
Dq7��d     @ �      �(S�5a      
�1�a      �
D�7aH� ؝ �
 
 �	d     @ �      �(S�a      ��a      �
DA8a�� �� ���d     @ �      �(S��a      ��a      �
D�8a�� 5� ���d     @ �      ��QcF��>   isArray �a      ]C�a      �C�a      �C�a      �`    |�a:      Qd���   readContext CQd~e    useCallback CQd��R�
   useContext  CQd�	�	   useEffect   C Qf�~��   useImperativeHandle CQe&~}J   useLayoutEffect CQc��   useMemo CQd����
   useReducer  CQc�eW   useRef  CQcJZ y   useStateCQe��8�   useDebugValue   CQd���   useResponderCQe�K�j   useDeferredValueCQe&7T^   useTransition   C
H�
H�
HQ
H�
H
H�
H
HQ
H�
H
HQ
H�
H!
H�|�a:      
H�C
H�C
HQC
H�C
HC
H�C
HC
HQC
H�C
HC
HQC
H�C
H!C
H�C(S5a      
6�a      �
Ha!� v� �
 
 �	d     @ �      (S��a      ��a      �
H�a�� �� ���d     @ �      (S�Pd   
   dj.useMemo  a�� � 
H��d     @ �      (S5a      
6Pd      .useReducer a� � 
HQ��d     @ �      (S�Pd   	   dj.useRef   a�� -� 
H�
 
 �	d     @ �      (S�a      ��a      �
H!at�  � �d       ���� @ ( ���d     @ �      (S5a      
6�a      �
H�a� ]� �
 
 �	d     @ �      |�a:      
H�C
H�C
HQC
H�C
HC
H�C
HC
HQC
H�C
HC
HQC
H�C
H!C
H�C(SPd      ej.useState a�� 
� �
 
 �	d     @ �      (S5a      
A6�a      �
H!aE� ҥ �d       ���� @ ( ���d     @ �      (S�a      ��a      �
H�a� /� �
 
 �	d     @ �      |�a:      
H�C
H�C
HQC
H�C
HC
H�C
HC
HQC
H�C
HC
HQC
H�C
H!C
H�C(SPd      fj.useState aʦ ܦ �
 
 �	d     @ �      (S5a      
�6�a      �
H!a� �� �d       ���� @ ( ���d     @ �      (S�a      ��a      �
H�a��  � �
 
 �	d     @ �       Qf*���   ReactCurrentOwner   �a
      Qd��3
   dehydrated  FQdR�r	   retryTime   `    (S�
A8ag� �� ���d     @ �      (S�
�8a�� �� ���d     @ �      (S�
�8a�� b� ���d     @ �      (S�
9ar� �� ���d     @ �      �IQb�|f   ceil(S
a� � �
 
 �	d     @ �      (S�
Aa.� -� ���d     @ �      (S�
aM� n� ���d     @ �      (S�Pd   	   ef.render   a�� �� I��d     @ �      Qcj!�   render  (SPd   
   ef.unmount  a�� %� �d       ���� @  I��d       @ �      Qc�m^�   unmount (S�
Aa5� p� ���d     @ �      (S
�a�� �� �
 
 �	d     @ �      (S�
�a�� �� ���d     @ �      (S�

a�� �� ���d     @ �      (S<�`4   ]K`    Di    (         % .% /% 0% 1�,Rc   ��        I`����Da,� h� ���d    @@�      (S�5a      Qb2��Y   mk  �a      ��a      Qcqpl   Events  Pc      .currenta�� � I��d     @ �      (S
H4a$� F� I
 
 �	d       @ �      (S�IaO� �� I��d     @ �      �a      
HA5C�`   <Ll                                                   �a      ]H(S��a�� �� I��d     @ �      �(S|�`�   (L`   4Rc   ��        ��`�� I`����Daؑ J� �$Qg���   findFiberByHostInstance l�a2       Qf��gg   overrideHookState   FQe�P3-   overrideProps   F Qf
�L   setSuspenseHandler  FQe�z�U   scheduleUpdate  F Qf��r   currentDispatcherRefC$Qg��
�   findHostInstanceByFiber C
HA>C(Qh�0	e   findHostInstancesForRefresh FQe+��   scheduleRefresh FQd���=   scheduleRootF Qfꉿe   setRefreshHandler   FQe�L��   getCurrentFiber F
4a*
L�(S5a      
�	�a      �
La�� �� �
Hq=
 �	d     @ �      �(S��a      ��a      �
HA>a� -� ���d     @ �      K`    Dy8            � �(  ��  &� ��*  &�~&�})&� ��?  &�(�/�� /��/�	'�[��&�]��� ��d      ���   �d    @@�      ,�a      �CQd��0l
   bundleType  `    Qc��*-   version Qc�R   16.13.1  Qf��.   rendererPackageName Qdb�(�	   react-dom   �Qd�_��   createPortal(S5a      Qb��   I   Pd      .findDOMNodead� K� I
 �d     @ �      QdF�{"   findDOMNode (S�Pd      I.flushSync a`� �� I��d     @ �      Qd"m�	   flushSync   (S�Pd   	   I.hydrate   a�� � I��d     @ �      Qc�U��   hydrate (S�Pc      I.rendera1� p� I��d     @ �      (S�a      
L��a      �$Qgve0o   unmountComponentAtNode  a�� .� �d      ݛ��@   �d       ���� @   I�
 �	d     @ �      
L�$QgFy*j   unstable_batchedUpdates (S5a      ��a      �$Qg�Y3�   unstable_createPortal   al� �� I
 �d     @ �      
L(S��a   %   
L��a   $   �0Qj�^�;#   unstable_renderSubtreeIntoContainer a�� h� I��d     @ �      
L
L�
L�K`    D��X            �  �%� ������&��	�	
�
	�
�������������������� � !�! "�"!#�#"$�$#%�%$&�&%'�'&(�(')�)(*�*)&��+*&��,++�-,,�.--�/..�0//�100�211�322�433�544�655�766�877�988�:99�;::�<;;�=<<�>==�?>>�@??�A@@�BAA�CBB�DCC�EDD�FE&��GFE�HGF�IHG�JIH�KJI�LKJ�MLK�NML�ONM�PON�QPO�RQP�SRQ�TSR�UTS�VUT�WVU�XWV�YXW�ZYX�[ZY�\[Z�]\[�^]\�_^]�`_^�a`_�ba`�cba�dcb�edc�fed�gfe�hgf�ihg�jih�kji�lkj�mlk�nml�onm�pon�qpo�rqp�srq�tsr�uts�vut�wvu�xwv�yxw�zyx�{zy�|{z�}|{�~}|�~&���&����}���~������������������������������������������������������������������������������������������������������������������������������������������������������&����������������������������&􁰯&󁱰������������������������������������&򁻺����������������&�������&����&�����������&�������������������������������������Á��ā��Ł��Ɓ��ǁ��ȁ��Ɂ��ʁ��ˁ��́��́��΁��ρ��Ё��с��ҁ��Ӂ��ԁ��Ձ��ց��ׁ��؁��ف��ځ��ہ��܁��݁��ށ��߁���������������������������������������������&����������������� � � � � � �� �� �� �� �� �� �� �	� �
	� �
� �� �   �  �  �  �  �  �  �  �  � 	 � 
 �  �  �  �  �  �  �  �  �   �!   �"!  �#"  �$#  �%$  �&%  �   '  &�&� � &�]��&�]��� �(&      }) )&� �*' /��+ %�    ! " #~ $|	 %~ &~ '~ ( ,
 s �5  , &� (��- s �  , &� (��- &� (��. sP )&� (��/ &� (��0  * + , - �1( . �2) / �3* 0 . 1 2 3&� (��/ &� (��4 &� (��5 &� (��6  4 (��7  5 (��8 &� (��9  &� (��:"  6 (��;$ &� (��<& &� (��=( &� (��>*  7 (��?, &� (��@. &� yA0   8 B1 &� (��C3 &� (��D5  9~ :~ ;~ < E&� (��F7 &� G&�Y���9&� (��H; &� �I+&�Y���= zJ? &� (��H@ &� �K,&�Y���B zLD %&� (��HE &� �M-&�Y���G zNI %&� (��HJ &� �O.&�Y���L P&� (��FN &� G&�Y���P&� (��HR &� �Q/&�Y���T zRV %&� (��HW &� �S0&�Y���Y zT[ %&� (��H\ &� �U1&�Y���^ zV` %&� (��Ha &� �W2&�Y���c zXe %&� (��Hf &� �Y3&�Y���h yZj  = �[4 > \&� (��Fk &� G&�Y���m&� (��Ho &� �]5&�Y���q ^&� (��Fs &� G&�Y���u&� (��Hw &� �_6&�Y���y z`{ %&� (��H| &� �a7&�Y���~ zb� %&� (��H� &� �c8&�Y��փ <&�&� d&�&�&� e&� f&�&�%�e��� -��d�  zg� %&� (��H� &� �h9&�Y��֌&� (��/  ? ?&� (��D� &� i&�Y��֐ �  ?&� }j� )&� -��i� %� ?&� (��D� &� k&�Y��֕ �  ?&� }l� )&� -��k� %� ym�   @ n� s �  n� &� (��o� &� �$  n� &� (��o� &� p&�Y��֡ �	 ��   A%� �$  n� &� (��o� &� q&�Y��֣ �	 ��   B%� �$  n� &� (��o� &� r&�Y��֥ �	 ��   C%� �$  n� &� (��o� &� s&�Y��֧ �	 ��   D%� �$  n� &� (��o� &� t&�Y��֩ �	 ��   E%� �$  n� &� (��o� &� u&�Y��֫ �	 ��   F%� �$  n� &� (��o� &� v&�Y��֭ �	 ��   G%� �$  n� &� (��o� &� w&�Y��֯ �	 ��   H%� �$  n� &� (��o� &� x&�Y��ֱ �	 ��   I%� �$  n� &� (��o� &� y&�Y��ֳ �	 ��   J%� �$  n� &� (��o� &� z&�Y��ֵ �	 ��   K%� �$  n� &� (��o� &� {&�Y��ַ �	 ��   L%� �$  n� &� (��o� &� |&�Y��ֹ �	 ��   M%� �$  n� &� (��o� &� }&�Y��ֻ �	 ��   N n� s �  n� &� (��~�  O �:&� ��;&�]�׿ Q ��< R }�� )&� �&� �&�^���� /����  �&� �&�^���� /����  �&� �&�^���� /����  �&� �&�^���� /���� %� S~ T~ U ) ��  -� &� (��.� &� �&�Y����&� (����  U �&� , o�� �E  S&� (���� &� �S� S&� (���� &� �S� S&� (���� &� �S� �&� , o�� �  S&� (���� &� �S� �&�]��� V �&�]��� W �&�]��� X �&�]��� Y �&� (��F� &� G&�Y���� Z �� s �  ��  �	  �� &�e�� � [ \ ��= ]|� ^ _|� ` a b c �� &�e�� � d �� &�e�� � e |  f �&� (��F&� G&� Y������ g �&� (��F&� G&� Y������ h~ i �� &� e����  	 j �� &� e����   k z�%&�&� V 1����&� W 1����&� X 1����.&� Y 1����'�� �&� (��F&� G&� Y������&�&� ^������ �&� (��F&� G&� Y������&�&� ^������&� ^������ ��>&� �&� (��F&� G&� Y������ &�&� ^������"%� l 6 m n }�$) o z�%% p B1 &� (���&&� o&� Y������(&� (��H*&� ��?&� Y������, *&� }�.)&� }�/)&� ^������0 q � r � s � t � u v w �2s �  �4 �  x �6s �  �8 �  y �:&� (���<&� X����>&� (���@&�$&� Y������B&� (���D&�&� Y������F&� �&�%� 4��H z �&�%� 4��I { �&�%� 4��J | } ~  *&�i&� (��CK&� }�M)&� ��@ /���N ��A /���P ��B /���Rh /���T ��C /���V ^������Xi&� }�Z)&� ��D /���[ ��E /���]%� -���_i&� ��F -���al&�i&� ]����ci&� (���e&� }�g)&� Y������h �i&� (���e&� }�j)&� Y������k � z�m% � ) �  �&� ,  o��n �&� ) �+  �&� -�  o��p �  -� &� (���r&� ) �  �&� ,  o��t � %�P � ) �.  �P �% %� � &�%� i��v � &�%� l��w � �x&� (���z&� &� Y������| � }�~&� }�&� �&� (��F�&� G&� Y������� /����%� /���� }��&� �&� (��F�&� G&� Y������� /����%� /���� }��&� �&� (��F�&� G&� Y������� /����%� /����%� � � � }��)&� � /���� ��G /����'�� }��) � }��&� }��&� �&� (��F�&� G&� Y������� /����%� /����%� � � � � ) �L 5&� �&� ]����� �2  -� &� (���rP � 	&� -� &� (���r i��� � }��)&� � /���� � /���� ��H /����'��i&� (���e&� }��)&� Y������� � }��) � � � � � �&� (����&� }��)&�%� /���� ��I /���� ��J /���� ��K /���� Y������� � �&� (����&� }��)&� Y������� � }�� � }��)&� � /���� ��L /����'�� B1 &� (����s �  B1 &� (���� � %� � B1 &� (��C3 &� (��D� � ) �3  �&� -�  o��� � &� -� &� (���r l��� � }��&� }��&� �&� (��F�&� G&� Y������� /����%� /����%� � � � � � }��)&� � /���� ��M /����'��i&� (���e&� }��)&� Y������� �i&� (���e&� }��)&� ��N /���� Y������� � �&� (����&� }��)&� Y������� � }��) � }�� � �&� (����&� }��)&� � O /���%� /���� �P /��� �Q /��� �R /��� Y������� � �&� (����&� } )&� Y������ � �&� (����&� }	)&�%� /��� Y������ �i&� (���e&� }
)&� Y������	 � �&� (����&� })&� �S /�� �T /�� Y������ � })&� i /��� �U /���'�� �V&� &� (��F&� G&� Y������&� ]���� �W&�^&�\&�]&� [����  })&�%� /�� %� /��"%� /��$%� /��&%� /��( ]����* |, �� �~ � }-)&� � /��.%� � }0) � � � 6 � 5 �%� �%� �%� �%� � 7 �%� �%� �~ �%� �%� �	 %� �
  �X � � � � 4&� \��1 � '&� � j��3 �  4 �
  �Y � } 4) � � � � � � � ?&� (��k5 �&� (��!7&� e����  9&� (��"; � }#=)&� �$Z /��%> �&[ /��'@ �(\ /��)B �*] /��+D%� � ,F&� (��-H �&� ]����J �&� ]����L �~ � }.N)&� � /��O%� � }/Q)&� � /��R%� � }0T)&� � /��U%� � }1W) � ?&� (��iX � ?&� (��k5 � � � � � � }2Z)&�� /��3[%� /��4]%� /��5_%� /��6a%� /��7c%� /��8e%� /��9g%� /��:i%� /��;k%� /��<m%� /��=o%� /��>q%� /��?s%� /��@u%� � }Aw)&�� /��3x� /��4z� /��5|� /��6~ �B^ /��7� �C_ /��8� �D` /��9� �Ea /��:� �Fb /��;�� /��<�%� /��=�%� /��>� �Gc /��?� �Hd /��@�%� � }I�)&�� /��3�� /��4�� /��5�� /��6�%� /��7�%� /��8�%� /��9�� /��:�%� /��;� �Je /��<�%� /��=�%� /��>� �Kf /��?� �Lg /��@�%� � }M�)&�� /��3�� /��4�� /��5�� /��6�%� /��7�%� /��8�%� /��9�� /��:�%� /��;� �Nh /��<�%� /��=�%� /��>� �Oi /��?� �Pj /��@�%� � � � � ?&� (��Q� � � }R�) � �Sk � �Tl � �Um � �Vn � W�s �  W� �	  X� � �� s �  ��  �	  ��  � �:&� (��Y� � ?&� (��iX � ?&� (��Q� � � � �  � � � � � � � � � � � � � � ����? ����? � �     �       	Z 
     �Zo  �[p    �\q  &� (��C�&� �]r -��^� &� (��C�&� �_s -��`� �at  �bu  �cv  �dw + �ex&� �fy&� �gz&� �h{&�'�� [���� � }i�&� zj�&�&�\ 1�����&�] 1�����&�^ 1�����&�%� 1�����&� & 1�����&�e 1�����&� �k| 1�����&�
 1�����&� 1�����	&�I 1�����
&�3 1�����&�� 1�����%� /��l�'�� �m}&� }n�)&�[ /��o� ]�����%� - /�  - p� �q~ - r� �s - t� �u� - v� �w� - ^� �x� - y�%� - z� �{� - |� �}� - ~�  - � � ��1  �  @ ��y P P P P P P Ӏ
� 
��Y �`@ P �`@ � &0��� 
��Y ���&P �`.0��� � � � ��`� 0@ � @ $P � @ P ` 0'0��� &@ @ P 0'P �I p P @ ���� 0� 0����&L&	$P 	@h 0'� ��&� L`�Y 0� �� 00	`0���&�� P 	�9� `2� ��� L&s2� 0� L&0	`2� L� ��� 0� 0'L ����� 0� @ L&L&L����`2� 0� 0� 0� 0� �����&0� 0� 0� 0� 0P � ��`&�&� ,� ,� ,�    
 �	d    @@       &
&
�&
�&
�&
�&
�&
&
�&
q &
Q!&
1"&
#&
�#&
�$&
�%&
�&&
Q-&
1.&
/�D&
q0&
Q1&
12&
3&
�3�D&
�5&
�6&
q7&
Q8&
19&
:&
�:&
�;&
�<D&
>&
�>&
 &
�&
�&
�&
�&
a&
A&
&
&
�&
�&
�&
�&
a&
A&
!&
&
�&
�&
�&
�&
� &
q!&
Q"�D&
�#&
�$&
�%&
a&&
A'D&
�(&
q)&
Q*&
1+&
,D&
a-&
�7&
�8&
�9&
q:&
Q;&
1<&
=&
�=&
�>&
  &
 �&
 �&
 �&
 �&
 a&
 A&
 !&
 &
 �&
 �&
 �	&
 �
&
 a&
 A&
 !&
 &
 �&
 �&
 �&
 �&
 a&
 A&
 !&
 &
 �&
 �&
 �&
 �&
 a&
 A&
 A&
 !&
  &
 � &
 �!&
 �"&
 �#&
 a$&
 A%&
 !&&
 '&
 �'&
 �(&
 �)&
 �*&
 a+&
 A,&
 a-&
 �.&
 a/&
 A0&
 !1&
 2&
 �2&
 �3&
 �4&
 �5&
 a6&
 A7&
 !8&
 9&
 �9&
 �:&
 �;&
 �<&
 a=D&
 �>&
$ &
$�&
$�&
$�&
$�&
$a&
$A&
$!&
$&
$�&
$�&
$�	&
$�
&
$a&
$A&
$!&
$&
$�&
$�D&
$&
$�&
$�&
$�&
$�&
$�&
$a&
$A&
$! &
$!&
$�!&
$�"&
$�#&
$�$&
$a%&
$A&D&
$�'D&
$)&
$1*&
$+&
$�+&
$�,&
$�-&
$�.&
$q/&
$�0&
$�1&
$�2&
$q3&
$Q4&
$15&
$6&
$�6&
$�7&
$�8&
$�9&
$�:&
$�;&
$q<&
$Q=&
$1>&
$Q?�D&
(�&
(�&
(&
(�&
(�&
(��D&
(q&
(Q&
(1	&
(
&
(�
&
(�&
(�&
(�&
(q&
(Q&
(1&
(&
(�&
(�&
(�&
(�&
(q&
(Q&
(1&
(&
(�&
(�&
(�&
(�&
(q&
(QD&
(�&
(�&
(q &
(Q!&
(1"&
(#&
(�#D&
(A%&
(!&&
('&
(�'&
(�(&
(�)&
(�*&
(a+D&
(�,D&
(.�D&
(�/&
(a0&
(A1&
(!2&
(3&
(�3&
(�4&
(�5D&
(�6&
(8&
(�8&
(�9&
(�:&
(�;&
(q<&
(Q=&
(1>&
(?&
, &
,�&
,�&
,�&
,�D&
,�&
,�&
,�&
,q&
,Q&
,1	&
,
&
,A&
,q&
,�&
,�&
,�&
,q&
,Q&
,1&
,&
,�&
,�&
,�&
,�&
,q&
,Q&
,1&
, &
,� &
,�!&
,�"&
,�#&
,q$&
,Q%�D&
,�&&
,�'&
,�(&
,1*&
,-&
,�-&
,�.&
,a?&
0q&
0Q&
0&
0q&
0�&
0�!&
0�%&
0�)&
0Q-&
4&
4A&
4&
4�!&
4'&
4Q3&
4!7D&
4�8&
4�9&
8�&
8�)&
<�&
<�&
<A&
<�&
<A&
<�&
<�"&
<A%&
<q'&
<�,&
<q-&
@&
@�&
@�&
@�&
@&
@a/&
@�5&
@�9&
D�&
D1&
Da&
D�&
D!&
D!#&
D�%&
Dq'&
D�-&
D4&
D�4&
DA9&
D�:&
D<&
D�=&
H�	&
Hq&
H�&
H1&
H�&
HD&
H�&
Ha&
H�D&
H�&
H&
HAD&
H1 &
Ha#&
HA$&
H!%&
H&&
H!'&
H(&
H�(&
H�)&
HQ+D&
HQ-&
H1.&
H/&
H�/&
H�0&
H13&
H�5&
H�6&
Ha9&
HA:&
L&
L�&
Lq&
L�&
LA&
L�&
L�D&
L�&
L�`   DI]d    @`       �
 �(K`    Di             �   &� &�� &�^���&�� $Rc   �`          Ib����     � �b        
 �	d       @P        �A�Eo��   L���X     1�'~�����EFs�]D��WJ�a����@�A�Eo��                                                                                                                                                                                                                                                                               					.addClass( 'menu-item-edit-inactive' )
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
