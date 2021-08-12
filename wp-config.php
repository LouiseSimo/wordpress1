<?php
/**
 * La configuration de base de votre installation WordPress.
 *
 * Ce fichier est utilisé par le script de création de wp-config.php pendant
 * le processus d’installation. Vous n’avez pas à utiliser le site web, vous
 * pouvez simplement renommer ce fichier en « wp-config.php » et remplir les
 * valeurs.
 *
 * Ce fichier contient les réglages de configuration suivants :
 *
 * Réglages MySQL
 * Préfixe de table
 * Clés secrètes
 * Langue utilisée
 * ABSPATH
 *
 * @link https://fr.wordpress.org/support/article/editing-wp-config-php/.
 *
 * @package WordPress
 */

// ** Réglages MySQL - Votre hébergeur doit vous fournir ces informations. ** //
/** Nom de la base de données de WordPress. */
define( 'DB_NAME', 'wordpress' );

/** Utilisateur de la base de données MySQL. */
define( 'DB_USER', 'root' );

/** Mot de passe de la base de données MySQL. */
define( 'DB_PASSWORD', '' );

/** Adresse de l’hébergement MySQL. */
define( 'DB_HOST', 'localhost' );

/** Jeu de caractères à utiliser par la base de données lors de la création des tables. */
define( 'DB_CHARSET', 'utf8mb4' );

/**
 * Type de collation de la base de données.
 * N’y touchez que si vous savez ce que vous faites.
 */
define( 'DB_COLLATE', '' );

/**#@+
 * Clés uniques d’authentification et salage.
 *
 * Remplacez les valeurs par défaut par des phrases uniques !
 * Vous pouvez générer des phrases aléatoires en utilisant
 * {@link https://api.wordpress.org/secret-key/1.1/salt/ le service de clés secrètes de WordPress.org}.
 * Vous pouvez modifier ces phrases à n’importe quel moment, afin d’invalider tous les cookies existants.
 * Cela forcera également tous les utilisateurs à se reconnecter.
 *
 * @since 2.6.0
 */
define( 'AUTH_KEY',         'Q]FqzA0$O?h}xAfu?h+plf;|L6q:qH[_r!|06=S;3lRYtP`|7[SNk,1m}X}$VyN+' );
define( 'SECURE_AUTH_KEY',  '9[*p-hEM6{.8XIf>2. eLF9k3#Ue9Xm./{>sjLo80zou16 1CV#|Q0Q<^!B:02 P' );
define( 'LOGGED_IN_KEY',    '*y$w<]^oVRa97.rPUr;pV}4Nw@:k caVYg`F*.Z]Cu! +?^UE2oB19[p7a+6|EP>' );
define( 'NONCE_KEY',        'zD{P^,;cs2nV-NhWjEiMZEgOP#*:B(p&mj=RqDn|?It.^_1fBwBc@)g&QR,Y<9#o' );
define( 'AUTH_SALT',        '!:3gFPulUAxN-2M<UAZqm6raL,R|hV~e+uy)3=L]baxb]-SPr{mR(+Ekj@H9(tcZ' );
define( 'SECURE_AUTH_SALT', 'DH3 mmZa[X#tE~ EsUPZ8*2)f}`Jv_+P+{OYN&D2=e?WwOeQh/tlV q.k4DZ5i^*' );
define( 'LOGGED_IN_SALT',   'u>?WG-R^3?1?6;`uH1.:rd(0i(uI?wK^{f^TlW(e*1Pq*X{j5;A6Rgx`FVjFW+jC' );
define( 'NONCE_SALT',       '035kpu6bj)$FtD!4Al]S SMm/OZ~  nB.5Og*X,U;]j0w,#ZBBjrB>PcrrHy}(su' );
/**#@-*/

/**
 * Préfixe de base de données pour les tables de WordPress.
 *
 * Vous pouvez installer plusieurs WordPress sur une seule base de données
 * si vous leur donnez chacune un préfixe unique.
 * N’utilisez que des chiffres, des lettres non-accentuées, et des caractères soulignés !
 */
$table_prefix = 'wp_';

/**
 * Pour les développeurs : le mode déboguage de WordPress.
 *
 * En passant la valeur suivante à "true", vous activez l’affichage des
 * notifications d’erreurs pendant vos essais.
 * Il est fortemment recommandé que les développeurs d’extensions et
 * de thèmes se servent de WP_DEBUG dans leur environnement de
 * développement.
 *
 * Pour plus d’information sur les autres constantes qui peuvent être utilisées
 * pour le déboguage, rendez-vous sur le Codex.
 *
 * @link https://fr.wordpress.org/support/article/debugging-in-wordpress/
 */
define( 'WP_DEBUG', false );

/* C’est tout, ne touchez pas à ce qui suit ! Bonne publication. */

/** Chemin absolu vers le dossier de WordPress. */
if ( ! defined( 'ABSPATH' ) )
  define( 'ABSPATH', dirname( __FILE__ ) . '/' );

/** Réglage des variables de WordPress et de ses fichiers inclus. */
require_once( ABSPATH . 'wp-settings.php' );
