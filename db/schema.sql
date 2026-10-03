-- The game's database (MariaDB 10.11; MySQL 8 differs where noted): the star charts, the factions, and
-- each vessel kind's design as layers of JSON, merged with JSON_MERGE_PATCH (docs/database.md):
--   base_systems.defaults   what every system of a type is
--   class_systems.props     what a class's system changes from that  (the design)
--   ship_systems.props      what a ship's system changes from its class's (live state; unused so far)
-- A patch sets what it names at any depth, keeps what it doesn't, and a null removes a key; arrays
-- are replaced whole, so anything changed item by item is an object keyed by id (links are rows).
-- node tools/db.js migrate   applies this (it refuses to drop a table that holds rows).

-- (The tables this replaces, from the first draft: dropped only while empty; tools/db.js checks.)
drop view if exists vw_all_ships;
drop table if exists system_properties;
drop table if exists default_properties;
drop table if exists systems;

create table if not exists factions (
  faction_id   int not null auto_increment primary key,
  faction_name varchar(32) not null unique
);

-- The star charts (config/starsystem/<id>.json) and what's on them.
create table if not exists star_systems (
  star_system_id   int not null auto_increment primary key,
  star_system_code varchar(32) not null unique,
  star_system_name varchar(64) not null,
  size             int not null
);
create table if not exists chart_objects (
  chart_object_id int not null auto_increment primary key,
  star_system_id  int not null,
  kind            enum('starbase', 'body', 'waypoint', 'relay') not null,
  name            varchar(64) not null,
  x               double not null,
  y               double not null,
  unique key (star_system_id, kind, name),
  foreign key (star_system_id) references star_systems (star_system_id) on delete cascade
);

-- Stars, by their Morgan-Keenan class (G2V): spectral class, subclass (0-9.5), luminosity class, and
-- any peculiarity (e, m, n, p, var...); mk_code puts them together.
create table if not exists spectral_classes (
  spectral_class varchar(2) not null primary key,
  description    varchar(64) not null
);
alter table spectral_classes add column if not exists colour varchar(32) null, add column if not exists temp_min_k int null, add column if not exists temp_max_k int null;
create table if not exists luminosity_classes (
  luminosity_class varchar(4) not null primary key,
  description      varchar(32) not null,
  sort_order       int not null
);
create table if not exists stars (
  star_id    int not null auto_increment primary key,
  star_name  varchar(32) not null
);
-- (The first draft's single letter, star_types, gives way to the full class.)
alter table stars drop foreign key if exists stars_ibfk_1;
alter table stars drop column if exists star_type;
drop table if exists star_types;
alter table stars add column if not exists star_system_id int null, add column if not exists spectral_class varchar(2) null,
  add column if not exists spectral_subclass decimal(3,1) null check (spectral_subclass between 0 and 9.5),
  add column if not exists luminosity_class varchar(4) null, add column if not exists peculiarity varchar(16) null,
  add column if not exists star_x double null, add column if not exists star_y double null, add column if not exists radius double null,
  add column if not exists star_owner int null;
alter table stars add column if not exists mk_code varchar(32) as (concat(coalesce(spectral_class, ''),
  coalesce(if(spectral_subclass = floor(spectral_subclass), cast(floor(spectral_subclass) as char), cast(spectral_subclass as char)), ''),
  coalesce(luminosity_class, ''), coalesce(peculiarity, ''))) virtual;
alter table stars add constraint stars_star_system foreign key if not exists stars_star_system (star_system_id) references star_systems (star_system_id);
alter table stars add constraint stars_spectral foreign key if not exists stars_spectral (spectral_class) references spectral_classes (spectral_class);
alter table stars add constraint stars_luminosity foreign key if not exists stars_luminosity (luminosity_class) references luminosity_classes (luminosity_class);
alter table stars add unique key if not exists star_in_system (star_system_id, star_name);
-- Planets by their class (the Federation's letters: M for Earth-like, J for a gas giant...).
create table if not exists planet_types (
  planet_type_id   int not null auto_increment primary key,
  planet_type_name varchar(16) not null
);
alter table planet_types modify planet_type_name varchar(32) not null,
  add column if not exists planet_type_code char(1) null, add column if not exists atmosphere varchar(64) null,
  add column if not exists surface varchar(64) null, add column if not exists habitability varchar(64) null, add column if not exists description varchar(255) null;
alter table planet_types add unique key if not exists planet_type_code (planet_type_code);
create table if not exists planets (
  planet_id   int not null auto_increment primary key,
  planet_name varchar(32) not null
);
alter table planets add column if not exists planet_type int null, add column if not exists planet_owner int null,
  add column if not exists star_id int null, add column if not exists x double null, add column if not exists y double null, add column if not exists radius double null;
alter table planets add constraint planets_star foreign key if not exists planets_star (star_id) references stars (star_id);
alter table planets add unique key if not exists planet_of_star (star_id, planet_name);

-- The system types (config/system-types.json): role, resources, and the defaults every system of the
-- type starts from (what all of them share, as the designs have it).
create table if not exists base_systems (
  base_system_id   int not null auto_increment primary key,
  base_system_name varchar(32) not null unique
);
alter table base_systems add column if not exists role varchar(16) null, add column if not exists info json null,
  add column if not exists defaults json not null default '{}';


-- A vessel kind (a ship class, the starbases', the relays'): its name and everything about it that
-- isn't a system (places, seats, org chart, ...), as JSON.
create table if not exists classes (
  class_id   int not null auto_increment primary key,
  class_name varchar(32) not null
);
alter table classes add column if not exists class_code varchar(32) null, add column if not exists kind enum('ship', 'starbase', 'relay') not null default 'ship',
  add column if not exists faction_id int null, add column if not exists design json not null default '{}';
alter table classes add unique key if not exists class_code (class_code);
alter table classes add constraint classes_faction foreign key if not exists classes_faction (faction_id) references factions (faction_id);

-- Its systems: the graph's nodes, by their id in the design (console-helm, warp-core, ...), each
-- with what it changes from its type's defaults; a part names the system it's part of.
create table if not exists class_systems (
  class_id       int not null,
  system_key     varchar(64) not null,
  parent_key     varchar(64) null,
  base_system_id int not null,
  props          json not null default '{}',
  sort_order     int not null default 0,
  primary key (class_id, system_key),
  foreign key (class_id) references classes (class_id) on delete cascade,
  foreign key (base_system_id) references base_systems (base_system_id)
);
-- Its links, one row per pair and resource: system_key draws (pull) from other_key, or sends back
-- (push); link: { pull, push, connect, rate, pushRate, pri, min, why }.
create table if not exists class_links (
  class_id   int not null,
  system_key varchar(64) not null,
  other_key  varchar(64) not null,
  resource   enum('power', 'eps', 'odn', 'deu', 'am', 'heat') not null,
  link       json not null,
  sort_order int not null default 0,
  primary key (class_id, system_key, other_key, resource),
  foreign key (class_id, system_key) references class_systems (class_id, system_key) on delete cascade,
  foreign key (class_id, other_key) references class_systems (class_id, system_key) on delete cascade
);

-- (One row a type: duplicates from before the name was unique go, and the class systems that pointed
-- at them, which tools/db.js load puts back.)
delete cs from class_systems cs join base_systems b1 on b1.base_system_id = cs.base_system_id
  join base_systems b2 on b2.base_system_name = b1.base_system_name and b2.base_system_id < b1.base_system_id;
delete b1 from base_systems b1 join base_systems b2 on b2.base_system_name = b1.base_system_name and b2.base_system_id < b1.base_system_id;
alter table base_systems add unique key if not exists base_system_name (base_system_name);

-- Ships, and (later) their systems' and links' live state over their class's.
create table if not exists ships (
  ship_id   int not null auto_increment primary key,
  ship_name varchar(32) not null unique
);
alter table ships add column if not exists ship_class int null, add column if not exists star_id int null, add column if not exists planet_id int null,
  add column if not exists x double null, add column if not exists y double null;
create table if not exists ship_systems (
  ship_id    int not null,
  system_key varchar(64) not null,
  props      json not null default '{}',
  primary key (ship_id, system_key),
  foreign key (ship_id) references ships (ship_id) on delete cascade
);
create table if not exists ship_links (
  ship_id    int not null,
  system_key varchar(64) not null,
  other_key  varchar(64) not null,
  resource   enum('power', 'eps', 'odn', 'deu', 'am', 'heat') not null,
  link       json not null,
  primary key (ship_id, system_key, other_key, resource),
  foreign key (ship_id) references ships (ship_id) on delete cascade
);

-- World state the database can move on its own (MariaDB events, the slow world ticks: orbits, starbase
-- restock, timers, history; the relay keeps the fast ship ticks). Rows here, no events yet.
alter table ships add column if not exists mothballed boolean not null default false, add column if not exists state json not null default '{}',
  add column if not exists updated_at timestamp not null default current_timestamp on update current_timestamp;
-- A planet's orbit: where it is at any time (an event moves planets.x and y along it).
create table if not exists orbits (
  planet_id      int not null primary key,
  star_id        int not null,
  radius         double not null,
  period_seconds double not null,
  phase_deg      double not null default 0,
  epoch          timestamp not null default current_timestamp,
  foreign key (planet_id) references planets (planet_id) on delete cascade,
  foreign key (star_id) references stars (star_id)
);
-- What a starbase holds of each resource, and how fast it restocks.
create table if not exists starbase_stock (
  chart_object_id   int not null,
  resource          enum('deu', 'am', 'torpedoes', 'emergency-batteries', 'warp-cores') not null,
  amount            double not null default 0,
  capacity          double not null,
  restock_per_hour  double not null default 0,
  updated_at        timestamp not null default current_timestamp on update current_timestamp,
  primary key (chart_object_id, resource),
  foreign key (chart_object_id) references chart_objects (chart_object_id) on delete cascade
);
-- Things that happen at a time (a repair done, a convoy due, a restock): fired once, or every repeat_seconds.
create table if not exists timers (
  timer_id       int not null auto_increment primary key,
  kind           varchar(32) not null,
  subject        json not null default '{}',
  due_at         timestamp not null,
  repeat_seconds int null,
  payload        json not null default '{}',
  fired_at       timestamp null,
  key (due_at)
);
-- Snapshots: what something was at a time (for history and replays).
create table if not exists world_history (
  snapshot_id bigint not null auto_increment primary key,
  taken_at    timestamp not null default current_timestamp,
  kind        varchar(32) not null,
  subject     varchar(64) not null,
  state       json not null,
  key (kind, subject, taken_at)
);

-- A class's systems as its design has them: each type's defaults, patched by the class.
create or replace view vw_class_systems as
select c.class_id, c.class_code, c.class_name, cs.system_key, cs.parent_key, b.base_system_name as system_type, cs.sort_order,
       json_merge_patch(b.defaults, cs.props) as props
from class_systems cs
join classes c on c.class_id = cs.class_id
join base_systems b on b.base_system_id = cs.base_system_id;

-- A ship's systems as they are: the type's defaults, patched by its class, patched by the ship.
create or replace view vw_ship_systems as
select s.ship_id, s.ship_name, c.class_code, cs.system_key, cs.parent_key, b.base_system_name as system_type,
       json_merge_patch(json_merge_patch(b.defaults, cs.props), coalesce(ss.props, '{}')) as props
from ships s
join classes c on c.class_id = s.ship_class
join class_systems cs on cs.class_id = c.class_id
join base_systems b on b.base_system_id = cs.base_system_id
left join ship_systems ss on ss.ship_id = s.ship_id and ss.system_key = cs.system_key;

-- A ship's links as they are: its class's, each patched by the ship's.
create or replace view vw_ship_links as
select s.ship_id, s.ship_name, cl.system_key, cl.other_key, cl.resource,
       json_merge_patch(cl.link, coalesce(sl.link, '{}')) as link
from ships s
join class_links cl on cl.class_id = s.ship_class
left join ship_links sl on sl.ship_id = s.ship_id and sl.system_key = cl.system_key and sl.other_key = cl.other_key and sl.resource = cl.resource;
