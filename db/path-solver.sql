-- The path-tracing solver in SQL (tools/path-solver.js's rules; tools/bench.js times it against the
-- JavaScript). The network is what the JavaScript builds (its nodes and links, numbered), loaded into
-- pt_node and pt_edge; pt_solve() serves the loads in pri order, each from the nearest source with
-- power left (its own vessel's generators, then its stores, then across a dock the same; the most on
-- hand of the nearest), along a path the recursive query finds with room on every link and node, and
-- rolls back a load that can't reach its minimum. (The batteries' charging and the conduits'
-- pass-through, which come after, are the JavaScript's only.) Not used by the game.
create table if not exists pt_node (
  id     int not null primary key,
  kind   enum('source', 'bus', 'eps', 'pass', 'load') not null,
  m      int not null,
  last   tinyint not null default 0,
  cap    double not null default 1e300,
  used   double not null default 0,
  lft    double not null default 0,
  given  double not null default 0,
  pri    double not null default 0,
  want   double not null default 0,
  min_n  double not null default 0,
  got    double not null default 0
) engine = memory;
create table if not exists pt_edge (
  id   int not null primary key,
  src  int not null,
  dst  int not null,
  cap  double not null default 1e300,
  used double not null default 0,
  key (src)
) engine = memory;
create table if not exists pt_log (
  src  int not null,
  path varchar(2000) not null,
  amt  double not null
) engine = memory;

drop procedure if exists pt_solve;
create procedure pt_solve()
begin
  declare done int default 0;
  declare lid int; declare lwant, lmin, lpri double; declare lm int;
  declare vgot, t, er, nr, sl double;
  declare bsrc int; declare bpath varchar(2000);
  declare tr int;
  declare cur cursor for select id, want, min_n, pri, m from pt_node where kind = 'load' and want > 0 order by pri, id;
  declare continue handler for not found set done = 1;
  open cur;
  loads: loop
    fetch cur into lid, lwant, lmin, lpri, lm;
    if done then leave loads; end if;
    set vgot = 0;
    delete from pt_log;
    set tr = 0;
    tiers: while tr < 4 do
      paths: loop
        if vgot >= lwant - 1e-9 then leave tiers; end if;
        set bsrc = null, bpath = null;
        -- (Every path from a source of this tier with power left, to this load, room on every link and node.)
        with recursive p (src, node, hops, path, visited) as (
          select s.id, s.id, 0, cast('' as char(2000)), cast(concat(',', s.id, ',') as char(2000))
          from pt_node s where s.kind = 'source' and s.lft > 1e-9 and (s.m <> lm) * 2 + s.last = tr
          union all
          select p.src, e.dst, p.hops + 1, concat(p.path, lpad(e.id, 6, '0'), ','), concat(p.visited, e.dst, ',')
          from p join pt_edge e on e.src = p.node join pt_node n on n.id = e.dst
          where p.node <> lid and p.hops < 12 and e.cap - e.used > 1e-9 and locate(concat(',', e.dst, ','), p.visited) = 0
            and (n.id = lid or (n.kind in ('bus', 'eps', 'pass') and n.cap - n.used > 1e-9))
        )
        select p.src, p.path into bsrc, bpath from p join pt_node s on s.id = p.src
        where p.node = lid order by p.hops, s.lft desc, s.id, p.path limit 1;
        set done = 0;
        if bsrc is null then leave paths; end if;
        -- (What the path can carry: the source, what's still wanted, the tightest link and node.)
        select min(e.cap - e.used) into er from pt_edge e where locate(concat(lpad(e.id, 6, '0'), ','), bpath) > 0;
        select coalesce(min(n.cap - n.used), 1e300) into nr from pt_edge e join pt_node n on n.id = e.dst
          where locate(concat(lpad(e.id, 6, '0'), ','), bpath) > 0 and n.kind in ('bus', 'eps', 'pass');
        select lft into sl from pt_node where id = bsrc;
        set t = least(sl, lwant - vgot, er, nr);
        if t <= 1e-9 then leave paths; end if;
        update pt_node set lft = lft - t, given = given + t where id = bsrc;
        update pt_edge set used = used + t where locate(concat(lpad(id, 6, '0'), ','), bpath) > 0;
        update pt_node n join pt_edge e on e.dst = n.id set n.used = n.used + t
          where locate(concat(lpad(e.id, 6, '0'), ','), bpath) > 0 and n.kind in ('bus', 'eps', 'pass');
        insert into pt_log (src, path, amt) values (bsrc, bpath, t);
        set vgot = vgot + t;
      end loop;
      set tr = tr + 1;
    end while;
    -- (Short of its minimum: everything it took, given back.)
    if lpri >= 1000 and vgot > 1e-9 and vgot < lmin - 1e-9 then
      update pt_node s join (select src, sum(amt) a from pt_log group by src) l on l.src = s.id set s.lft = s.lft + l.a, s.given = s.given - l.a;
      update pt_edge e join (select e2.id, sum(l.amt) a from pt_log l join pt_edge e2 on locate(concat(lpad(e2.id, 6, '0'), ','), l.path) > 0 group by e2.id) x on x.id = e.id set e.used = e.used - x.a;
      update pt_node n join (select e2.dst, sum(l.amt) a from pt_log l join pt_edge e2 on locate(concat(lpad(e2.id, 6, '0'), ','), l.path) > 0 group by e2.dst) x on x.dst = n.id
        set n.used = n.used - x.a where n.kind in ('bus', 'eps', 'pass');
    else
      update pt_node set got = vgot where id = lid;
    end if;
    set done = 0;
  end loop;
  close cur;
end;
